require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('NOVO QR CODE GERADO:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Tudo certo! A secretária Ana está conectada e rodando.');
});

client.on('message', async message => {
    console.log(`[DEBUG] Mensagem crua recebida de: ${message.from} | Corpo: ${message.body}`);

    if (message.fromMe) return;

    try {
        console.log('A enviar mensagem para a OpenAI...');
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: `Você é a Ana, secretária virtual de um(a) psicanalista. Seu tom é extremamente acolhedor, profissional, empático, mas altamente persuasivo e focado em conversão.
                    
                    SEU OBJETIVO PRINCIPAL: Acolher a dor ou a busca do cliente, gerar valor sobre o processo terapêutico/psicanalítico e conduzir a pessoa de forma natural, sutil e irresistível a agendar uma sessão.
                    
                    DIRETRIZES DE ABORDAGEM:
                    1. Valide os sentimentos da pessoa com empatia genuína (mostre que você entende o momento dela).
                    2. Faça perguntas abertas e direcionadas para entender brevemente o que ela está a enfrentar (ansiedade, autoconhecimento, conflitos, etc.).
                    3. Quebre objeções comuns (medo de julgamento, tempo, dúvida se funciona) com elegância.
                    4. Sempre finalize direcionando para o agendamento oficial, enviando o link de forma convidativa: https://psicanalise-site.vercel.app/
                    5. Mantenha as respostas fluidas, naturais e com o tamanho ideal para o WhatsApp (evite textos excessivamente longos ou robóticos).` 
                },
                { 
                    role: "user", 
                    content: message.body 
                }
            ],
        });

        const respostaIA = completion.choices[0].message.content;
        console.log(`Resposta gerada pela IA: ${respostaIA}`);
        await message.reply(respostaIA);

    } catch (error) {
        console.error('Erro ao comunicar com a OpenAI:', error);
        await message.reply('Desculpe, ocorreu um pequeno erro ao processar a sua mensagem. Como posso ajudar com o seu agendamento?');
    }
});

client.initialize();