const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');

// Inicialize a API do OpenAI (certifique-se de que a variável de ambiente OPENAI_API_KEY está configurada na VM)
const openai = new OpenAI();

// SEU LINK DE AGENDAMENTO
const LINK_AGENDAMENTO = "https://seu-site-de-agendamentos.com.br";

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot conectado com sucesso!');
        }
    });

    // Controle para evitar duplicidade de mensagens recentes
    const processedMessages = new Set();

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageId = msg.key.id;
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);

        setTimeout(() => processedMessages.delete(messageId), 60000);

        const remoteJid = msg.key.remoteJid;
        const nomeContato = msg.pushName || 'Cliente';

        const messageText = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || '';

        if (!messageText) return;

        console.log(`Mensagem de ${nomeContato} (${remoteJid}): ${messageText}`);

        try {
            // Mostra status de "digitando..." para parecer mais natural
            await sock.presenceSubscribe(remoteJid);
            await sock.sendPresenceUpdate('composing', remoteJid);

            // Chamada para a Inteligência Artificial da OpenAI
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini", // ou gpt-3.5-turbo
                messages: [
                    {
                        role: "system",
                        content: `Você é um assistente virtual atencioso de atendimento médico/clínica. O nome do cliente é ${nomeContato}. 
                        Seu objetivo é tirar dúvidas básicas, ser empático e **sempre conduzir o paciente para agendar a consulta pelo site**. 
                        Sempre que o paciente demonstrar interesse em marcar, tirar dúvidas sobre horários ou quiser prosseguir, forneça o link de agendamento de forma amigable. O link oficial é: ${LINK_AGENDAMENTO}`
                    },
                    { role: "user", content: messageText }
                ],
            });

            const respostaIA = completion.choices[0].message.content;

            // Envia a resposta gerada pela IA para o WhatsApp
            await sock.sendMessage(remoteJid, { text: respostaIA });

        } catch (error) {
            console.error('Erro ao processar mensagem com OpenAI:', error);
            await sock.sendMessage(remoteJid, { 
                text: `Olá, ${nomeContato}! Desculpe, tive um pequeno problema técnico aqui. Para agendar sua consulta diretamente, acesse nosso site: ${LINK_AGENDAMENTO}` 
            });
        }
    });
}

connectToWhatsApp();