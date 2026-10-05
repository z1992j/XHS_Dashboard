module.exports = {
  apps: [{
    name: 'broadband-api',
    script: 'src/index.js',
    cwd: '/home/admin/broadband-api',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    error_file: '/home/admin/logs/broadband-api-error.log',
    out_file: '/home/admin/logs/broadband-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // 这里的 env 是唯一能用「推代码」改动的环境变量通道。
    //
    // 原理：CD 会上传本文件并执行 pm2 reload，PM2 在进程启动时把这些值注入
    // process.env；而 src/index.js 用的是 require('dotenv').config()（没带
    // override），dotenv 默认不覆盖已存在的变量 —— 所以这里写的值会**压过**
    // 服务器上 .env 文件里的同名配置。
    //
    // 用途：服务器 .env 里钉死的变量，CD 从不上传 .env，改不动也看不见。
    // 需要改这类值又不想 SSH 时，在这里加一行、推一次代码即可。
    env: {
      NODE_ENV: 'production',

      // 文案模型。服务器 .env 里钉的是 XHS_AI_MODEL=deepseek-v4-flash，
      // 而 CD 从不上传 .env —— 它会一直覆盖代码默认值，DeepSeek 把 V4 Pro
      // 路由到 V4.1 Flash 的那次升级这台机器一直没吃到。这里的值优先级更高
      // （PM2 在进程启动时注入，dotenv 默认不覆盖已存在的变量），所以填在
      // 这里就能盖过它。
      //
      // 用稳定别名而不是具体型号：官方换主力模型时它自动跟随，不用再改一次。
      // 绝不要填 deepseek-v4.1-flash-expires-on-0910 这类带过期日期的内测 ID
      // —— 那个 09-10 就已经过期，填了所有文案生成会直接失败。
      //
      // 线上实际生效的型号看 GET /api/xhs/health 的 textModel 字段。
      XHS_AI_MODEL: 'deepseek-chat',
    },
  }],
};
