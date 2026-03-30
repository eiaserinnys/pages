module.exports = {
  apps: [
    {
      name: 'pages',
      script: './src/server.js',
      cwd: `${process.env.HOME}/services/pages/current`,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      watch: false,
      kill_timeout: 10000,
    },
  ],
};
