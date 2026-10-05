require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const setupXhsWriter = require('./xhs-writer');

const app = express();

// Trust the first reverse proxy hop (Nginx) so req.ip is the real client IP
app.set('trust proxy', 1);

app.use(cors());

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'broadband',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  queueLimit: 0,
});

setupXhsWriter(app, pool);

const PORT = parseInt(process.env.PORT || '3000', 10);
const server = app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', module: 'index', msg: `Server listening on :${PORT}` }));
});

// ====== Graceful shutdown: drain in-flight requests, then close DB pool ======
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', module: 'index', msg: `Received ${signal}, shutting down gracefully...` }));
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  server.close(async () => {
    try {
      await pool.end();
    } catch (e) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', module: 'index', msg: 'Error closing DB pool', error: e.message }));
    }
    process.exit(0);
  });
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
