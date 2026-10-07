const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');

// Inicialize a API do OpenAI (certifique-se de que a variável de ambiente OPENAI_API_KEY esteja configurada)
const openai = new OpenAI();

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

    // Armazenamento simples em memória para evitar duplicidade de mensagens recentes
    const processedMessages = new Set();

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const messageId = msg.key.id;
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);

        // Limpa o ID da memória após 1 minuto para não consumir muita RAM
        setTimeout(() => processedMessages.delete(messageId), 60000);

        const remoteJid = msg.key.remoteJid;
        
        // Pega o nome que a pessoa salvou no WhatsApp (pushName) ou define um padrão
        const nomeContato = msg.pushName || 'Cliente';

        // Extrai o texto da mensagem (suporta texto comum ou botões/templates)
        const messageText = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || '';

        if (!messageText) return;

        console.log(`Mensagem de ${nomeContato} (${remoteJid}): ${messageText}`);

        try {
            // Exemplo de integração usando o nome do contato na resposta
            await sock.sendMessage(remoteJid, { 
                text: `Olá, ${nomeContato}! Recebi a sua mensagem: "${messageText}". Como posso te ajudar hoje?` 
            });
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error);
        }
    });
}

connectToWhatsApp();