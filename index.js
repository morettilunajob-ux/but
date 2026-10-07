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
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ============================================================
// CONFIGURAÇÕES
// ============================================================

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
    'https://psicanalise-site.vercel.app/';

const NOME_ATENDENTE =
    process.env.NOME_ATENDENTE ||
    'Ana';

const FFMPEG_PATH =
    process.env.FFMPEG_PATH ||
    (
        process.platform === 'win32'
            ? 'ffmpeg'
            : '/home/opc/bin/ffmpeg'
    );

const AUTH_DIR =
    path.join(
        __dirname,
        'auth_info_baileys'
    );

const MAX_HISTORICO =
    20;

// ============================================================
// MEMÓRIA DAS CONVERSAS
// ============================================================

const conversas =
    new Map();

const primeirosContatos =
    new Set();

const mensagensProcessadas =
    new Set();

// ============================================================
// LOGGER
// ============================================================

const logger =
    pino({
        level: 'silent'
    });

// ============================================================
// UTILITÁRIOS
// ============================================================

function normalizarNome(nome) {

    if (!nome) {
        return 'você';
    }

    let resultado =
        String(nome)
            .replace(/\s+/g, ' ')
            .trim();

    if (!resultado) {
        return 'você';
    }

    if (resultado.length > 40) {
        resultado =
            resultado.substring(0, 40).trim();
    }

    return resultado;
}

function obterNomeWhatsApp(msg) {

    return normalizarNome(
        msg.pushName ||
        msg.verifiedBizName ||
        ''
    );
}

function obterJid(msg) {

    return (
        msg?.key?.remoteJid ||
        ''
    );
}

function lembrarMensagem(
    jid,
    role,
    content
) {

    if (!conversas.has(jid)) {
        conversas.set(
            jid,
            []
        );
    }

    const historico =
        conversas.get(jid);

    historico.push({
        role,
        content
    });

    while (
        historico.length >
        MAX_HISTORICO
    ) {
        historico.shift();
    }
}

function obterHistorico(jid) {

    return (
        conversas.get(jid) ||
        []
    );
}

function mensagemEDeSaudacao(texto) {

    if (!texto) {
        return false;
    }

    const textoNormalizado =
        texto
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[!?.,;:()[\]{}]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    const saudacoes = [
        'oi',
        'ola',
        'oie',
        'opa',
        'e ai',
        'eai',
        'bom dia',
        'boa tarde',
        'boa noite',
        'tudo bem',
        'fala',
        'fala ai',
        'salve',
        'hello'
    ];

    return saudacoes.includes(
        textoNormalizado
    );
}

function extrairTexto(msg) {

    const mensagem =
        msg?.message;

    if (!mensagem) {
        return '';
    }

    if (
        typeof mensagem.conversation === 'string'
    ) {
        return mensagem.conversation.trim();
    }

    if (
        typeof mensagem.extendedTextMessage?.text === 'string'
    ) {
        return mensagem.extendedTextMessage.text.trim();
    }

    if (
        typeof mensagem.ephemeralMessage?.message?.conversation === 'string'
    ) {
        return mensagem
            .ephemeralMessage
            .message
            .conversation
            .trim();
    }

    if (
        typeof mensagem.ephemeralMessage?.message?.extendedTextMessage?.text === 'string'
    ) {
        return mensagem
            .ephemeralMessage
            .message
            .extendedTextMessage
            .text
            .trim();
    }

    return '';
}

function obterAudioMessage(msg) {

    const mensagem =
        msg?.message;

    if (!mensagem) {
        return null;
    }

    if (mensagem.audioMessage) {
        return mensagem.audioMessage;
    }

    if (
        mensagem.ephemeralMessage
            ?.message
            ?.audioMessage
    ) {
        return (
            mensagem
                .ephemeralMessage
                .message
                .audioMessage
        );
    }

    return null;
}

// ============================================================
// WHISPER
// ============================================================

async function transcreverAudioLocal(
    filePath
) {

    const nomeBase =
        `whatsapp_${Date.now()}_${Math.random()
            .toString(36)
            .substring(2, 8)}`;

    const wavPath =
        path.join(
            os.tmpdir(),
            `${nomeBase}.wav`
        );

    try {

        console.log(
            '🔄 Convertendo áudio do WhatsApp para WAV...'
        );

        await execFileAsync(
            FFMPEG_PATH,
            [
                '-y',
                '-i',
                filePath,
                '-ar',
                '16000',
                '-ac',
                '1',
                '-c:a',
                'pcm_s16le',
                wavPath
            ],
            {
                timeout: 180000
            }
        );

        console.log(
            '✅ Áudio convertido para WAV.'
        );

        const audioBuffer =
            fs.readFileSync(
                wavPath
            );

        const formData =
            new FormData();

        formData.append(
            'file',
            new Blob(
                [
                    audioBuffer
                ],
                {
                    type:
                        'audio/wav'
                }
            ),
            path.basename(
                wavPath
            )
        );

        formData.append(
            'response_format',
            'json'
        );

        formData.append(
            'language',
            'pt'
        );

        console.log(
            '🧠 Enviando WAV para Whisper...'
        );

        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () => {
                    controller.abort();
                },
                180000
            );

        let response;

        try {

            response =
                await fetch(
                    `${TRANSCRIBER_URL}/inference`,
                    {
                        method: 'POST',
                        body: formData,
                        signal:
                            controller.signal
                    }
                );

        } finally {

            clearTimeout(
                timeout
            );
        }

        const responseText =
            await response.text();

        let data;

        try {

            data =
                JSON.parse(
                    responseText
                );

        } catch {

            throw new Error(
                `Resposta inválida do Whisper. HTTP ${response.status}: ${responseText}`
            );
        }

        if (!response.ok) {

            throw new Error(
                `Whisper HTTP ${response.status}: ${JSON.stringify(data)}`
            );
        }

        const texto =
            data?.text ||
            data?.transcription ||
            data?.transcript ||
            '';

        if (!texto) {

            throw new Error(
                `Whisper não retornou texto: ${JSON.stringify(data)}`
            );
        }

        return texto
            .trim();

    } finally {

        if (
            fs.existsSync(
                wavPath
            )
        ) {

            try {
                fs.unlinkSync(
                    wavPath
                );
            } catch {}
        }
    }
}

// ============================================================
// PROMPT DA ANA
// ============================================================

function criarPrompt(
    nomePaciente,
    primeiraInteracao
) {

    return `
/no_think

Você é ${NOME_ATENDENTE}, secretária humana da clínica.

IDENTIDADE OBRIGATÓRIA

Seu nome é ${NOME_ATENDENTE}.

Nunca diga que seu nome é Luiza, Laura, Julia, Mariana ou qualquer outro nome.

Nunca invente outro nome.

Você é sempre ${NOME_ATENDENTE}.

Você é uma secretária humana da clínica.

Nunca diga que é uma IA.

Nunca diga que é um robô.

Nunca diga que é um assistente virtual.

Nunca diga que usa inteligência artificial.

Nunca mencione NVIDIA, modelo, programação, API, sistema interno, código ou tecnologia.

NOME DO PACIENTE

O nome recebido do WhatsApp é:

${nomePaciente}

Quando for natural, chame a pessoa pelo nome.

Nunca invente um nome diferente.

Nunca troque o nome da pessoa.

Se o nome estiver disponível, use exatamente esse nome ou uma forma natural dele.

PRIMEIRO CONTATO

Esta é a primeira interação desta pessoa com você:

${primeiraInteracao ? 'SIM' : 'NÃO'}

Se for a primeira interação, a apresentação já foi feita pelo sistema.

Não repita uma apresentação longa.

Não diga novamente que acabou de chegar.

Não fique repetindo "Aqui é a Ana".

Depois da primeira mensagem, converse normalmente.

JEITO DE FALAR

Fale português brasileiro.

Seja natural.

Seja humana.

Seja simpática.

Seja acolhedora.

Pode usar emojis com moderação.

Use frases curtas e naturais.

Evite linguagem corporativa.

Evite linguagem de telemarketing.

Evite respostas mecânicas.

Evite listas enormes.

Evite repetir a mesma frase.

Evite terminar toda mensagem com "Posso ajudar em mais alguma coisa?".

Evite ficar empurrando agendamento em toda mensagem.

Não transforme uma conversa casual em propaganda.

CONVERSA

Converse como uma pessoa real.

Se a pessoa perguntar como você está, responda naturalmente.

Se a pessoa contar algo pessoal de forma casual, responda com naturalidade e empatia.

Quando fizer sentido, pergunte como a pessoa está.

Faça perguntas apenas quando elas ajudarem a conversa.

Não faça um interrogatório.

Não faça perguntas demais de uma vez.

Não seja fria.

Não seja exageradamente sentimental.

Não dramatize.

Não use medo para convencer a pessoa a marcar consulta.

Não crie urgência falsa.

Não invente problemas de saúde.

Não faça diagnóstico.

Não prescreva tratamento.

Não invente informações clínicas.

PERGUNTAS FORA DA CLÍNICA

Se a pessoa perguntar algo casual ou geral, responda naturalmente quando souber.

Não diga que você só pode falar sobre a clínica.

Não diga:

"Meu papel aqui é apenas..."

"Eu só posso ajudar com..."

"Posso ajudar somente com..."

Se a pergunta não tiver relação com a clínica e você puder responder de forma breve, responda.

Depois, se fizer sentido, a conversa pode voltar para a clínica.

AGENDAMENTO

Quando a pessoa demonstrar interesse em consulta, agendamento, horário, disponibilidade ou marcação, conduza naturalmente para o site.

Link oficial de agendamento:

${LINK_AGENDAMENTO}

Nunca invente horários.

Nunca invente disponibilidade.

Nunca invente preços.

Nunca invente formas de pagamento.

Nunca diga que existe um horário disponível se você não recebeu essa informação do sistema.

Quando necessário, mande o link de forma natural.

Exemplo de estilo:

"Claro 😊 Você consegue fazer o agendamento direto por aqui: ${LINK_AGENDAMENTO}"

Mas não repita sempre exatamente a mesma frase.

QUANDO A PESSOA PERGUNTAR "COM QUEM ESTOU FALANDO?"

Responda claramente que está falando com ${NOME_ATENDENTE}, da clínica.

Nunca invente outro nome.

ESTILO

Prefira respostas entre 1 e 5 frases.

Se uma resposta mais longa for realmente necessária, pode escrever mais.

Não faça textos enormes sem necessidade.

Não fique repetindo informações que a pessoa já sabe.

Use o histórico da conversa.

Nunca contradiga informações já dadas anteriormente.

Nunca diga que não lembra quando o histórico contiver a informação.

OBJETIVO

Seu objetivo é atender bem.

Conversar naturalmente.

Tirar dúvidas.

Acolher.

Conduzir a pessoa para o agendamento quando ela demonstrar interesse.

Faça isso de forma humana e natural.

Nunca seja insistente.
`;
}

// ============================================================
// NVIDIA
// ============================================================

async function chamarNvidia({
    jid,
    nomePaciente,
    textoUsuario,
    primeiraInteracao
}) {

    if (!NVIDIA_API_KEY) {
        throw new Error(
            'NVIDIA_API_KEY não configurada.'
        );
    }

    const historico =
        obterHistorico(jid);

    const messages = [
        {
            role: 'system',
            content:
                criarPrompt(
                    nomePaciente,
                    primeiraInteracao
                )
        },
        ...historico,
        {
            role: 'user',
            content: textoUsuario
        }
    ];

    console.log(
        '🟢 Enviando para NVIDIA...'
    );

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => {
                controller.abort();
            },
            120000
        );

    let response;

    try {

        response =
            await fetch(
                NVIDIA_URL,
                {
                    method: 'POST',

                    headers: {
                        Authorization:
                            `Bearer ${NVIDIA_API_KEY}`,

                        'Content-Type':
                            'application/json',

                        Accept:
                            'application/json'
                    },

                    body:
                        JSON.stringify({
                            model:
                                NVIDIA_MODEL,

                            messages,

                            temperature:
                                1.0,

                            top_p:
                                0.95,

                            max_tokens:
                                8192,

                            stream:
                                false
                        }),

                    signal:
                        controller.signal
                }
            );

    } finally {

        clearTimeout(
            timeout
        );
    }

    const responseText =
        await response.text();

    let data;

    try {

        data =
            JSON.parse(
                responseText
            );

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

    console.log(
        '✅ NVIDIA respondeu.'
    );

    const message =
        data?.choices?.[0]?.message;

    let resposta =
        message?.content;

    if (
        typeof resposta !== 'string'
    ) {
        resposta = '';
    }

    resposta =
        resposta
            .replace(
                /^```(?:text)?/i,
                ''
            )
            .replace(
                /```$/i,
                ''
            )
            .trim();

    if (!resposta) {

        console.error(
            '❌ NVIDIA retornou resposta sem conteúdo:',
            JSON.stringify(
                data
            )
        );

        throw new Error(
            'NVIDIA não retornou texto.'
        );
    }

    return resposta;
}

// ============================================================
// PRIMEIRA SAUDAÇÃO
// ============================================================

async function enviarPrimeiraSaudacao(
    sock,
    jid,
    nomePaciente
) {

    const nome =
        normalizarNome(
            nomePaciente
        );

    const saudacao =
        nome === 'você'
            ? `Olá! 😊 Aqui é a ${NOME_ATENDENTE}, da clínica. Como você está? Tudo bem por aí? Me conta, como posso te ajudar?`
            : `Olá, ${nome}! 😊 Aqui é a ${NOME_ATENDENTE}, da clínica. Como você está? Tudo bem por aí? Me conta, como posso te ajudar?`;

    console.log(
        `👋 Primeira abordagem para ${nome}`
    );

    await sock.sendMessage(
        jid,
        {
            text: saudacao
        }
    );

    lembrarMensagem(
        jid,
        'assistant',
        saudacao
    );
}

// ============================================================
// DOWNLOAD DO ÁUDIO
// ============================================================

async function baixarAudio(
    sock,
    msg
) {

    console.log(
        '⬇️ Baixando áudio do WhatsApp...'
    );

    const buffer =
        await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
                logger,
                reuploadRequest:
                    sock.updateMediaMessage
            }
        );

    const extension =
        '.ogg';

    const filePath =
        path.join(
            os.tmpdir(),
            `whatsapp_audio_${Date.now()}${extension}`
        );

    fs.writeFileSync(
        filePath,
        buffer
    );

    return filePath;
}

// ============================================================
// MENSAGEM PARA O USUÁRIO
// ============================================================

async function responderTexto({
    sock,
    jid,
    nomePaciente,
    texto,
    primeiraInteracao
}) {

    try {

        console.log(
            '🟢 Preparando resposta...'
        );

        const resposta =
            await chamarNvidia({
                jid,
                nomePaciente,
                textoUsuario:
                    texto,
                primeiraInteracao
            });

        lembrarMensagem(
            jid,
            'user',
            texto
        );

        lembrarMensagem(
            jid,
            'assistant',
            resposta
        );

        console.log(
            `🤖 Resposta: ${resposta}`
        );

        await sock.sendMessage(
            jid,
            {
                text:
                    resposta
            }
        );

        console.log(
            '✅ Mensagem enviada!'
        );

    } catch (error) {

        console.error(
            '❌ Erro na NVIDIA:',
            error.message
        );

        const fallback =
            'Poxa, tive um probleminha para responder agora 😕 Pode me chamar de novo em um instante?';

        await sock.sendMessage(
            jid,
            {
                text:
                    fallback
            }
        );

        lembrarMensagem(
            jid,
            'assistant',
            fallback
        );
    }
}

// ============================================================
// PROCESSAMENTO PRINCIPAL
// ============================================================

async function processarMensagem(
    sock,
    msg
) {

    try {

        if (!msg?.message) {
            return;
        }

        if (msg.key?.fromMe) {
            return;
        }

        const jid =
            obterJid(msg);

        if (!jid) {
            return;
        }

        if (
            jid === 'status@broadcast'
        ) {
            return;
        }

        const messageId =
            msg.key?.id;

        if (messageId) {

            if (
                mensagensProcessadas.has(
                    messageId
                )
            ) {
                return;
            }

            mensagensProcessadas.add(
                messageId
            );

            if (
                mensagensProcessadas.size >
                1000
            ) {

                const primeiro =
                    mensagensProcessadas
                        .values()
                        .next()
                        .value;

                mensagensProcessadas.delete(
                    primeiro
                );
            }
        }

        const nomePaciente =
            obterNomeWhatsApp(
                msg
            );

        let texto =
            extrairTexto(msg);

        const audioMessage =
            obterAudioMessage(
                msg
            );

        // ====================================================
        // ÁUDIO
        // ====================================================

        if (audioMessage) {

            console.log(
                `🎤 Áudio recebido de ${nomePaciente}`
            );

            const audioPath =
                await baixarAudio(
                    sock,
                    msg
                );

            try {

                console.log(
                    '🧠 Transcrevendo localmente...'
                );

                texto =
                    await transcreverAudioLocal(
                        audioPath
                    );

                console.log(
                    `🗣️ Transcrição: "${texto}"`
                );

            } finally {

                if (
                    fs.existsSync(
                        audioPath
                    )
                ) {

                    try {
                        fs.unlinkSync(
                            audioPath
                        );
                    } catch {}
                }
            }
        }

        if (!texto) {
            return;
        }

        console.log(
            `📩 ${nomePaciente} (${jid}): ${texto}`
        );

        // ====================================================
        // PRIMEIRO CONTATO
        // ====================================================

        const primeiraInteracao =
            !primeirosContatos.has(
                jid
            );

        if (primeiraInteracao) {

            await enviarPrimeiraSaudacao(
                sock,
                jid,
                nomePaciente
            );

            primeirosContatos.add(
                jid
            );

            // Se for somente "oi", "olá" etc.,
            // a saudação inicial já é suficiente.
            if (
                mensagemEDeSaudacao(
                    texto
                )
            ) {
                return;
            }
        }

        // ====================================================
        // NVIDIA
        // ====================================================

        await responderTexto({
            sock,
            jid,
            nomePaciente,
            texto,
            primeiraInteracao:
                false
        });

    } catch (error) {

        console.error(
            '❌ Erro ao processar mensagem:',
            error
        );
    }
}

// ============================================================
// INICIAR WHATSAPP
// ============================================================

async function iniciarWhatsApp() {

    console.log(
        '🚀 Iniciando Ana...'
    );

    console.log(
        `🤖 Modelo: ${NVIDIA_MODEL}`
    );

    console.log(
        `🧠 Whisper: ${TRANSCRIBER_URL}`
    );

    console.log(
        `📅 Agendamento: ${LINK_AGENDAMENTO}`
    );

    console.log(
        `👩 Atendente: ${NOME_ATENDENTE}`
    );

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            AUTH_DIR
        );

    const sock =
        makeWASocket({
            auth:
                state,

            printQRInTerminal:
                false,

            logger
        });

    // ========================================================
    // QR CODE
    // ========================================================

    sock.ev.on(
        'connection.update',
        async (update) => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            if (qr) {

                console.log(
                    '\n📱 ESCANEIE ESTE QR CODE NO WHATSAPP:\n'
                );

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );
            }

            if (
                connection === 'open'
            ) {

                console.log(
                    '\n✅ WhatsApp conectado!'
                );

                console.log(
                    `👩 ${NOME_ATENDENTE} está online.`
                );
            }

            if (
                connection === 'close'
            ) {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;

                console.log(
                    '❌ Conexão fechada.'
                );

                console.log(
                    `🔄 Reconectar: ${shouldReconnect}`
                );

                if (
                    shouldReconnect
                ) {

                    setTimeout(
                        () => {
                            iniciarWhatsApp();
                        },
                        3000
                    );
                } else {

                    console.log(
                        '⚠️ WhatsApp deslogado. Será necessário autenticar novamente.'
                    );
                }
            }
        }
    );

    // ========================================================
    // SALVAR CREDENCIAIS
    // ========================================================

    sock.ev.on(
        'creds.update',
        saveCreds
    );

    // ========================================================
    // MENSAGENS
    // ========================================================

    sock.ev.on(
        'messages.upsert',
        async ({
            messages
        }) => {

            for (
                const msg of messages
            ) {

                await processarMensagem(
                    sock,
                    msg
                );
            }
        }
    );
}

// ============================================================
// ERROS GLOBAIS
// ============================================================

process.on(
    'unhandledRejection',
    (reason) => {

        console.error(
            '❌ Unhandled Rejection:',
            reason
        );
    }
);

process.on(
    'uncaughtException',
    (error) => {

        console.error(
            '❌ Uncaught Exception:',
            error
        );
    }
);

// ============================================================
// START
// ============================================================

iniciarWhatsApp()
    .catch(
        (error) => {

            console.error(
                '❌ Falha ao iniciar o bot:',
                error
            );

            process.exit(
                1
            );
        }
    );