module.exports = {
  apps: [
    {
      name: 'pages',
      script: './src/server.js',
      cwd: '/home/eias/services/pages/current',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      error_file: '/home/eias/.pm2/logs/pages-error.log',
      out_file: '/home/eias/.pm2/logs/pages-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      watch: false,
      kill_timeout: 10000,
    },
  ],
};
