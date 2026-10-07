const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const openai = new OpenAI();
const LINK_AGENDAMENTO = "https://seu-site-de-agendamentos.com.br"; // Lembre-se de trocar pelo seu link real

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n--- LEIA O QR CODE ABAIXO PELO SEU WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('\n✅ Bot conectado com sucesso e pronto para receber mensagens!');
        }
    });

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
        const nomeContato = msg.pushName || 'você';

        const messageText = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || '';

        if (!messageText) return;

        console.log(`[Nova Mensagem] ${nomeContato} (${remoteJid}): ${messageText}`);

        try {
            // REMOVIDO O "DIGITANDO...": Ele causa travamento em contatos @lid.
            
            console.log('⏳ Pensando na resposta com a Inteligência Artificial...');

            // PERSONALIDADE DA IA ATUALIZADA
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: `Você é uma atendente humana, gentil e simpática de uma clínica, conversando pelo WhatsApp. O nome do paciente é ${nomeContato}.
                        Regras OBRIGATÓRIAS:
                        1. NUNCA diga que você é uma inteligência artificial, robô ou assistente virtual. Aja 100% como uma pessoa real.
                        2. Fale de forma natural, curta e coloquial. Pareça uma mensagem real de WhatsApp (ex: use "Oi!", "Tudo bem?", e evite frases longas de telemarketing).
                        3. Não ofereça ajuda com frases robóticas tipo "Como posso te ajudar hoje?". Seja mais casual, como "Oi ${nomeContato}, tudo bem? Em que posso te ajudar?".
                        4. Quando a pessoa quiser marcar consulta, perguntar de horários ou valores, mande o link de agendamento de forma leve e natural. Exemplo: "Se quiser, você já pode dar uma olhadinha nos horários livres e agendar direto por aqui: ${LINK_AGENDAMENTO}".`
                    },
                    { role: "user", content: messageText }
                ],
            });

            const respostaIA = completion.choices[0].message.content;
            console.log(`🤖 IA Respondeu: ${respostaIA}`);

            await sock.sendMessage(remoteJid, { text: respostaIA });
            console.log('✅ Mensagem enviada para o WhatsApp do cliente!');

        } catch (error) {
            console.error('❌ Erro ao processar mensagem com a OpenAI:', error);
        }
    });
}

connectToWhatsApp();