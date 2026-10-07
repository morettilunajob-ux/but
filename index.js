const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// Inicialize a API do OpenAI
// (A chave de API será lida pelo PM2 através do seu ecosystem.config.js)
const openai = new OpenAI();

// SEU LINK DE AGENDAMENTO
const LINK_AGENDAMENTO = "https://seu-site-de-agendamentos.com.br";

async function connectToWhatsApp() {
    // Salva a sessão do WhatsApp na pasta auth_info_baileys
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        // O logger fica silenciado para não poluir a tela, o QR code será impresso manualmente
        logger: pino({ level: 'silent' }) 
    });

    // Salva as credenciais sempre que houver uma atualização
    sock.ev.on('creds.update', saveCreds);

    // Monitora o status da conexão e gera o QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Exibe o QR Code no terminal de forma legível
        if (qr) {
            console.log('\n--- LEIA O QR CODE ABAIXO PELO SEU WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\n✅ Bot conectado com sucesso e pronto para receber mensagens!');
        }
    });

    // Controle de mensagens em memória para evitar repostas duplicadas/triplicadas
    const processedMessages = new Set();

    // Monitora as mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        
        // Ignora mensagens enviadas pelo próprio bot ou avisos do sistema
        if (!msg.message || msg.key.fromMe) return;

        // Filtro anti-duplicidade
        const messageId = msg.key.id;
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);

        // Limpa o ID da memória após 1 minuto para não pesar a RAM
        setTimeout(() => processedMessages.delete(messageId), 60000);

        const remoteJid = msg.key.remoteJid;
        
        // Pega o nome que a pessoa salvou no próprio WhatsApp (pushName)
        const nomeContato = msg.pushName || 'Cliente';

        // Extrai o texto da mensagem suportando diferentes formatos
        const messageText = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || '';

        if (!messageText) return;

        console.log(`[Nova Mensagem] ${nomeContato} (${remoteJid}): ${messageText}`);

        try {
            // Simula que o bot está "digitando..." para parecer mais natural
            await sock.presenceSubscribe(remoteJid);
            await sock.sendPresenceUpdate('composing', remoteJid);

            // Chamada para a Inteligência Artificial da OpenAI
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini", // Pode mudar para gpt-3.5-turbo se preferir
                messages: [
                    {
                        role: "system",
                        content: `Você é um assistente virtual atencioso de atendimento médico/clínica. O nome do cliente é ${nomeContato}. 
                        Seu objetivo é tirar dúvidas básicas, ser empático e **sempre conduzir o paciente para agendar a consulta pelo site**. 
                        Sempre que o paciente demonstrar interesse em marcar, tirar dúvidas sobre horários ou quiser prosseguir, forneça o link de agendamento de forma amigável. O link oficial é: ${LINK_AGENDAMENTO}`
                    },
                    { role: "user", content: messageText }
                ],
            });

            const respostaIA = completion.choices[0].message.content;

            // Envia a resposta final para o WhatsApp
            await sock.sendMessage(remoteJid, { text: respostaIA });

        } catch (error) {
            console.error('Erro ao processar mensagem com a OpenAI:', error);
            // Mensagem de segurança caso a IA caia
            await sock.sendMessage(remoteJid, { 
                text: `Olá, ${nomeContato}! Desculpe, tive um pequeno problema técnico. Para agendar sua consulta rapidamente, por favor acesse nosso site: ${LINK_AGENDAMENTO}` 
            });
        }
    });
}

connectToWhatsApp();