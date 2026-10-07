module.exports = {
    apps: [
        {
            name: 'but',
            script: './index.js',
            cwd: __dirname,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};