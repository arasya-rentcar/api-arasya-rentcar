module.exports = {
  apps: [
    {
      name: 'api-arasya-rentcar',
      cwd: '/var/www/api-arasya-rentcar/current',
      script: 'dist/src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 5000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
