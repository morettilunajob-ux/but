require('dotenv').config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

const NVIDIA_MODEL =
    process.env.NVIDIA_MODEL ||
    'nvidia/nemotron-3-super-120b-a12b';

const NVIDIA_URL =
    'https://integrate.api.nvidia.com/v1/chat/completions';

const TRANSCRIBER_URL =
    process.env.TRANSCRIBER_URL ||
    'http://127.0.0.1:8765';

const LINK_AGENDAMENTO =
    process.env.LINK_AGENDAMENTO ||
    'https://seu-site-de-agendamentos.com.br';

if (!NVIDIA_API_KEY) {
    console.error('❌ NVIDIA_API_KEY não configurada.');
}


// ============================================================
// NVIDIA
// ============================================================

async function chamarNvidia(systemInstruction, messageText) {

    if (!NVIDIA_API_KEY) {
        throw new Error(
            'NVIDIA_API_KEY não configurada.'
        );
    }

    const response = await fetch(
        NVIDIA_URL,
        {
            method: 'POST',

            headers: {
                'Authorization': `Bearer ${NVIDIA_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },

            body: JSON.stringify({
                model: NVIDIA_MODEL,

                messages: [
                    {
                        role: 'system',
                        content: systemInstruction
                    },
                    {
                        role: 'user',
                        content: messageText
                    }
                ],

                temperature: 1.0,
                top_p: 0.95,
                max_tokens: 500,

                extra_body: {
                    chat_template_kwargs: {
                        enable_thinking: false
                    }
                },

                stream: false
            })
        }
    );

    const responseText =
        await response.text();

    let data;

    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error(
            `Resposta inválida da NVIDIA. HTTP ${response.status}: ${responseText}`
        );
    }

    if (!response.ok) {
        throw new Error(
            `NVIDIA HTTP ${response.status}: ${JSON.stringify(data)}`
        );
    }

    const resposta =
        data?.choices?.[0]?.message?.content;

    if (!resposta) {
        throw new Error(
            `NVIDIA não retornou texto: ${JSON.stringify(data)}`
        );
    }

    return resposta.trim();
}


// ============================================================
// TRANSCRIÇÃO LOCAL
// ============================================================

async function transcreverAudioLocal(
    filePath,
    mimeType = 'audio/ogg'
) {

    const audioBuffer =
        fs.readFileSync(filePath);

    const formData =
        new FormData();

    formData.append(
        'file',
        new Blob(
            [audioBuffer],
            {
                type: mimeType
            }
        ),
        path.basename(filePath)
    );

    const response =
        await fetch(
            `${TRANSCRIBER_URL}/inference`,
            {
                method: 'POST',
                body: formData
            }
        );

    const responseText =
        await response.text();

    let data;

    try {
        data = JSON.parse(responseText);
    } catch {
        throw new Error(
            `Resposta inválida do transcritor. HTTP ${response.status}: ${responseText}`
        );
    }

    if (!response.ok) {
        throw new Error(
            `Transcritor HTTP ${response.status}: ${JSON.stringify(data)}`
        );
    }

    const texto =
        data?.text ||
        data?.transcription ||
        data?.transcript ||
        '';

    if (!texto) {
        throw new Error(
            `Transcritor não retornou texto: ${JSON.stringify(data)}`
        );
    }

    return texto.trim();
}


// ============================================================
// WHATSAPP
// ============================================================

async function connectToWhatsApp() {

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        'auth_info_baileys'
    );

    const sock =
        makeWASocket({
            auth: state,

            logger: pino({
                level: 'silent'
            })
        });

    sock.ev.on(
        'creds.update',
        saveCreds
    );

    sock.ev.on(
        'connection.update',
        (update) => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            if (qr) {

                console.log(
                    '\n--- LEIA O QR CODE PELO SEU WHATSAPP ---'
                );

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );
            }

            if (connection === 'close') {

                const shouldReconnect =
                    lastDisconnect?.error?.output?.statusCode !==
                    DisconnectReason.loggedOut;

                if (shouldReconnect) {

                    console.log(
                        '⚠️ WhatsApp desconectado. Reconectando...'
                    );

                    setTimeout(
                        connectToWhatsApp,
                        3000
                    );
                }

            } else if (connection === 'open') {

                console.log(
                    '\n✅ Bot conectado com sucesso!'
                );

                console.log(
                    `🧠 NVIDIA: ${NVIDIA_MODEL}`
                );

                console.log(
                    `🎤 Transcrição local: ${TRANSCRIBER_URL}`
                );
            }
        }
    );


    const processedMessages =
        new Set();


    sock.ev.on(
        'messages.upsert',
        async ({ messages, type }) => {

            if (type !== 'notify') {
                return;
            }

            const msg =
                messages[0];

            if (!msg?.message) {
                return;
            }

            if (msg.key.fromMe) {
                return;
            }

            const messageId =
                msg.key.id;

            if (processedMessages.has(messageId)) {
                return;
            }

            processedMessages.add(
                messageId
            );

            setTimeout(
                () => {
                    processedMessages.delete(
                        messageId
                    );
                },
                60000
            );


            const remoteJid =
                msg.key.remoteJid;

            const nomeContato =
                msg.pushName || 'você';


            let messageText =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                '';


            // =================================================
            // ÁUDIO
            // =================================================

            const audioMessage =
                msg.message.audioMessage;

            if (audioMessage) {

                console.log(
                    `\n🎤 Áudio recebido de ${nomeContato}`
                );

                let tempFilePath = null;

                try {

                    console.log(
                        '⬇️ Baixando áudio do WhatsApp...'
                    );

                    const buffer =
                        await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            {
                                logger: pino({
                                    level: 'silent'
                                }),

                                reuploadRequest:
                                    sock.updateMediaMessage
                            }
                        );

                    tempFilePath =
                        path.join(
                            __dirname,
                            `temp_${Date.now()}.ogg`
                        );

                    fs.writeFileSync(
                        tempFilePath,
                        buffer
                    );

                    let mimeType =
                        audioMessage.mimetype ||
                        'audio/ogg';

                    if (mimeType.includes(';')) {
                        mimeType =
                            mimeType.split(';')[0];
                    }

                    console.log(
                        '🧠 Transcrevendo localmente...'
                    );

                    messageText =
                        await transcreverAudioLocal(
                            tempFilePath,
                            mimeType
                        );

                    console.log(
                        `🗣️ Transcrição: "${messageText}"`
                    );

                } catch (error) {

                    console.error(
                        '❌ Erro ao transcrever áudio:',
                        error.message
                    );

                    try {
                        await sock.sendMessage(
                            remoteJid,
                            {
                                text:
                                    'Não consegui ouvir seu áudio agora. Pode mandar de novo?'
                            }
                        );
                    } catch {}

                    return;

                } finally {

                    if (
                        tempFilePath &&
                        fs.existsSync(tempFilePath)
                    ) {

                        try {
                            fs.unlinkSync(
                                tempFilePath
                            );
                        } catch {}
                    }
                }
            }


            // =================================================
            // IGNORA MENSAGENS SEM TEXTO
            // =================================================

            if (!messageText?.trim()) {
                return;
            }


            console.log(
                `\n📩 ${nomeContato} (${remoteJid}): ${messageText}`
            );


            // =================================================
            // PROMPT
            // =================================================

            const systemInstruction = `
Você é uma atendente humana de uma clínica conversando pelo WhatsApp.

Nome do paciente: ${nomeContato}

REGRAS:

1. Responda sempre em português do Brasil.

2. Nunca diga que você é uma inteligência artificial.

3. Nunca diga que é um robô.

4. Nunca diga que é um assistente virtual.

5. Fale de forma natural, como uma atendente humana.

6. Seja curta, direta e coloquial.

7. Não escreva textos longos.

8. Não use linguagem de telemarketing.

9. Não use respostas artificiais como "Como posso ajudá-lo hoje?".

10. Leia o contexto da mensagem antes de responder.

11. Quando o paciente quiser marcar uma consulta, perguntar sobre horários ou valores, envie naturalmente o link de agendamento.

Link:
${LINK_AGENDAMENTO}

Exemplo:
"Você pode conferir os horários disponíveis e já agendar por aqui: ${LINK_AGENDAMENTO}"

Não invente informações que não estejam disponíveis.
`;


            // =================================================
            // NVIDIA
            // =================================================

            let respostaIA;

            try {

                console.log(
                    '🟢 Enviando para NVIDIA...'
                );

                respostaIA =
                    await chamarNvidia(
                        systemInstruction,
                        messageText
                    );

                console.log(
                    '✅ NVIDIA respondeu.'
                );

            } catch (error) {

                console.error(
                    '❌ Erro na NVIDIA:',
                    error.message
                );

                respostaIA =
                    'Desculpe, tive um probleminha para responder agora. Pode tentar novamente em alguns instantes?';
            }


            if (!respostaIA) {
                return;
            }


            console.log(
                `🤖 Resposta: ${respostaIA}`
            );


            try {

                await sock.sendMessage(
                    remoteJid,
                    {
                        text: respostaIA
                    }
                );

                console.log(
                    '✅ Mensagem enviada!'
                );

            } catch (error) {

                console.error(
                    '❌ Erro ao enviar mensagem:',
                    error.message
                );
            }
        }
    );
}


connectToWhatsApp()
    .catch(
        error => {
            console.error(
                '❌ Erro fatal:',
                error
            );
        }
    );