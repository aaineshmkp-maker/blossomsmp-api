const http = require('http');
const mysql = require('mysql2/promise');

const PLUGIN_SECRET = process.env.PLUGIN_SECRET || 'BlossomSMP$xK7#mQ3';
const ADMIN_KEY     = process.env.ADMIN_KEY     || '801084';
const PORT          = process.env.PORT          || 3000;

let db;
async function getDb() {
  if (db) return db;
  db = await mysql.createPool({
    host:     process.env.MYSQLHOST,
    user:     process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port:     process.env.MYSQLPORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
  });
  // Auto-create tables
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    edition ENUM('java','bedrock') DEFAULT 'java',
    coins INT DEFAULT 0,
    bank DECIMAL(10,4) DEFAULT 0,
    last_claim BIGINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS web_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    code VARCHAR(8) NOT NULL UNIQUE,
    edition ENUM('java','bedrock') DEFAULT 'java',
    used TINYINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL 10 MINUTE),
    INDEX (code)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL 30 DAY),
    INDEX (token)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(32),
    amount DECIMAL(10,4),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (user_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    minecraft_name VARCHAR(64),
    item_name VARCHAR(255),
    item_type VARCHAR(64),
    price DECIMAL(10,2),
    tebex_txn_id VARCHAR(128),
    gift_recipient VARCHAR(64),
    gift_message TEXT,
    status ENUM('pending','completed','delivered','refunded') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP NULL,
    INDEX (minecraft_name),
    INDEX (status)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS server_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(32) NOT NULL,
    username VARCHAR(64),
    data TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (event_type),
    INDEX (created_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS server_stats (
    id INT PRIMARY KEY DEFAULT 1,
    online INT DEFAULT 0,
    max_players INT DEFAULT 200,
    tps FLOAT DEFAULT 20,
    player_list TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS site_settings (
    id INT PRIMARY KEY DEFAULT 1,
    server_name VARCHAR(128) DEFAULT 'Blossom SMP',
    server_ip VARCHAR(128) DEFAULT '',
    discord_url VARCHAR(255) DEFAULT '',
    store_url VARCHAR(255) DEFAULT '',
    announcement TEXT DEFAULT '',
    maintenance TINYINT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )\`);
  await db.query(`CREATE TABLE IF NOT EXISTS votes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64),
    site VARCHAR(128),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(username)
  )`);
  console.log('[BlossomSMP] DB connected and tables ready.');
  return db;
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function randomToken() {
  return require('crypto').randomBytes(32).toString('hex');
}
function esc(s) { return String(s || '').replace(/[<>"']/g, '').trim().substring(0, 128); }

async function getUserByToken(db, token) {
  if (!token) return null;
  const [rows] = await db.query(
    `SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>NOW() LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function handleRequest(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Parse URL + query
  const url = new URL(req.url, `http://localhost`);
  const action = url.searchParams.get('action') || '';

  // Parse body
  let body = {};
  if (req.method === 'POST') {
    const raw = await new Promise(resolve => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => resolve(data));
    });
    try { body = JSON.parse(raw); } catch {}
  }

  const respond = (data, code = 200) => {
    res.writeHead(code);
    res.end(JSON.stringify(data));
  };

  let pool;
  try { pool = await getDb(); } catch (e) {
    return respond({ error: 'DB connection failed: ' + e.message }, 500);
  }

  try {
    switch (action) {

      case 'issue_code': {
        if ((body.secret || '') !== PLUGIN_SECRET) return respond({ error: 'Forbidden' }, 403);
        const username = esc(body.username);
        const edition  = body.edition === 'bedrock' ? 'bedrock' : 'java';
        if (!username) return respond({ error: 'Username required' }, 400);
        await pool.query(`DELETE FROM web_codes WHERE username=?`, [username]);
        let code;
        do { code = randomCode(); } while ((await pool.query(`SELECT id FROM web_codes WHERE code=? LIMIT 1`, [code]))[0].length > 0);
        await pool.query(`INSERT INTO web_codes (username,code,edition) VALUES (?,?,?)`, [username, code, edition]);
        return respond({ success: true, code, expires_in: '10 minutes' });
      }

      case 'login_with_code': {
        const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
        if (code.length !== 6) return respond({ error: 'Code must be 6 characters' }, 400);
        const [rows] = await pool.query(`SELECT * FROM web_codes WHERE code=? AND used=0 AND expires_at>NOW() LIMIT 1`, [code]);
        if (!rows.length) return respond({ error: 'Code is invalid or expired. Type /web in-game for a new one.' }, 401);
        const wc = rows[0];
        await pool.query(`UPDATE web_codes SET used=1 WHERE code=?`, [code]);
        const [existing] = await pool.query(`SELECT id FROM users WHERE username=? LIMIT 1`, [wc.username]);
        if (!existing.length) await pool.query(`INSERT INTO users (username,edition) VALUES (?,?)`, [wc.username, wc.edition]);
        const [urows] = await pool.query(`SELECT * FROM users WHERE username=? LIMIT 1`, [wc.username]);
        const user = urows[0];
        await pool.query(`DELETE FROM sessions WHERE user_id=? AND expires_at<NOW()`, [user.id]);
        const token = randomToken();
        await pool.query(`INSERT INTO sessions (user_id,token) VALUES (?,?)`, [user.id, token]);
        return respond({ success: true, token, username: user.username, edition: user.edition, coins: user.coins, bank: parseFloat(user.bank), last_claim: Number(user.last_claim) });
      }

      case 'get_profile': {
        const token = body.token || url.searchParams.get('token') || '';
        const user = await getUserByToken(pool, token);
        if (!user) return respond({ error: 'Invalid or expired session' }, 401);
        const [txs] = await pool.query(`SELECT type,amount,description,created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50`, [user.id]);
        const [purchases] = await pool.query(`SELECT item_name,item_type,price,status,created_at FROM purchases WHERE user_id=? ORDER BY created_at DESC LIMIT 20`, [user.id]);
        return respond({ username: user.username, edition: user.edition, coins: user.coins, bank: parseFloat(user.bank), last_claim: Number(user.last_claim), transactions: txs, purchases });
      }

      case 'save_state': {
        const user = await getUserByToken(pool, body.token || '');
        if (!user) return respond({ error: 'Unauthorized' }, 401);
        const coins = Math.max(0, parseInt(body.coins ?? user.coins));
        const bank  = Math.max(0, parseFloat(body.bank ?? user.bank));
        const last_claim = parseInt(body.last_claim ?? user.last_claim);
        await pool.query(`UPDATE users SET coins=?,bank=?,last_claim=? WHERE id=?`, [coins, bank, last_claim, user.id]);
        if (Array.isArray(body.transactions)) {
          for (const tx of body.transactions.slice(0, 5)) {
            await pool.query(`INSERT IGNORE INTO transactions (user_id,type,amount,description) VALUES (?,?,?,?)`,
              [user.id, esc(tx.type || 'other'), parseFloat(tx.amount || 0), esc(tx.description || tx.desc || '')]);
          }
        }
        return respond({ success: true });
      }

      case 'player_join': {
        if ((body.secret || '') !== PLUGIN_SECRET) return respond({ error: 'Forbidden' }, 403);
        const username = esc(body.username);
        const edition  = body.edition === 'bedrock' ? 'bedrock' : 'java';
        if (!username) return respond({ error: 'Username required' }, 400);
        await pool.query(`INSERT INTO users (username,edition) VALUES (?,?) ON DUPLICATE KEY UPDATE updated_at=NOW()`, [username, edition]);
        await pool.query(`INSERT INTO server_events (event_type,username,data) VALUES ('join',?,?)`, [username, JSON.stringify({ edition })]);
        return respond({ success: true });
      }

      case 'player_quit': {
        if ((body.secret || '') !== PLUGIN_SECRET) return respond({ error: 'Forbidden' }, 403);
        const username = esc(body.username);
        await pool.query(`INSERT INTO server_events (event_type,username) VALUES ('quit',?)`, [username]);
        return respond({ success: true });
      }

      case 'server_stats': {
        if ((body.secret || '') !== PLUGIN_SECRET) return respond({ error: 'Forbidden' }, 403);
        const online  = parseInt(body.online  || 0);
        const max     = parseInt(body.max     || 200);
        const tps     = parseFloat(body.tps   || 20.0);
        const players = JSON.stringify(body.players || []);
        await pool.query(`INSERT INTO server_stats (id,online,max_players,tps,player_list) VALUES (1,?,?,?,?) ON DUPLICATE KEY UPDATE online=?,max_players=?,tps=?,player_list=?,updated_at=NOW()`,
          [online, max, tps, players, online, max, tps, players]);
        return respond({ success: true });
      }

      case 'log_vote': {
        if ((body.secret || '') !== PLUGIN_SECRET) return respond({ error: 'Forbidden' }, 403);
        const username = esc(body.username);
        const site     = esc(body.site || 'unknown');
        await pool.query(`INSERT INTO votes (username,site) VALUES (?,?)`, [username, site]);
        await pool.query(`INSERT INTO server_events (event_type,username,data) VALUES ('vote',?,?)`, [username, JSON.stringify({ site })]);
        return respond({ success: true });
      }

      case 'announcement': {
        if ((body.secret || '') !== PLUGIN_SECRET) return respond({ error: 'Forbidden' }, 403);
        const username = esc(body.username);
        const type     = esc(body.type    || 'info');
        const message  = esc(body.message || '');
        await pool.query(`INSERT INTO server_events (event_type,username,data) VALUES (?,?,?)`, [type, username, JSON.stringify({ message })]);
        return respond({ success: true });
      }

      case 'live_feed': {
        const [events] = await pool.query(`SELECT id,event_type,username,data,created_at FROM server_events ORDER BY created_at DESC LIMIT 50`);
        const [statsRows] = await pool.query(`SELECT online,max_players,tps,player_list,updated_at FROM server_stats WHERE id=1 LIMIT 1`);
        const stats = statsRows[0] || { online: 0, max_players: 200, tps: 20, player_list: '[]', updated_at: null };
        stats.player_list = JSON.parse(stats.player_list || '[]');
        return respond({ events, stats });
      }

      case 'server_status': {
        const [rows] = await pool.query(`SELECT online,max_players,tps,player_list,updated_at FROM server_stats WHERE id=1 LIMIT 1`);
        if (rows.length) { rows[0].player_list = JSON.parse(rows[0].player_list || '[]'); return respond(rows[0]); }
        return respond({ online: 0, max_players: 200, tps: 20.0, player_list: [] });
      }

      case 'get_purchases': {
        const key = url.searchParams.get('key') || body.key || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const status = esc(url.searchParams.get('status') || body.status || 'pending');
        const [rows] = await pool.query(`SELECT p.*,u.edition FROM purchases p LEFT JOIN users u ON u.id=p.user_id WHERE p.status=? ORDER BY p.created_at DESC LIMIT 200`, [status]);
        return respond({ purchases: rows, count: rows.length });
      }

      case 'temp_login': {
        // Admin-issued temporary login code for testing without plugin
        const key = body.key || url.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const username = esc(body.username || 'TestPlayer');
        const edition = 'java';
        const tCoins = parseInt(body.coins || 100); await pool.query(`INSERT INTO users (username,edition,coins) VALUES (?,?,?) ON DUPLICATE KEY UPDATE coins=?,updated_at=NOW()`, [username, edition, tCoins, tCoins]);
        const [urows] = await pool.query(`SELECT * FROM users WHERE username=? LIMIT 1`, [username]);
        const user = urows[0];
        const token = randomToken();
        await pool.query(`INSERT INTO sessions (user_id,token) VALUES (?,?)`, [user.id, token]);
        // Also issue a web code
        let code;
        do { code = randomCode(); } while ((await pool.query(`SELECT id FROM web_codes WHERE code=? LIMIT 1`, [code]))[0].length > 0);
        await pool.query(`DELETE FROM web_codes WHERE username=?`, [username]);
        await pool.query(`INSERT INTO web_codes (username,code,edition) VALUES (?,?,?)`, [username, code, edition]);
        return respond({ success: true, code, token, username, message: 'Use this code on the website login, or use the token directly.' });
      }

      case 'get_settings': {
        const key = body.key || url.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const [rows] = await pool.query(`SELECT * FROM site_settings LIMIT 1`).catch(() => [[{}]]);
        return respond({ settings: rows[0] || {} });
      }

      case 'save_settings': {
        const key = body.key || url.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const { server_ip, server_name, discord_url, store_url, announcement, maintenance } = body;
        await pool.query(`INSERT INTO site_settings (id,server_ip,server_name,discord_url,store_url,announcement,maintenance) VALUES (1,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE server_ip=?,server_name=?,discord_url=?,store_url=?,announcement=?,maintenance=?,updated_at=NOW()`,
          [esc(server_ip||''), esc(server_name||'Blossom SMP'), esc(discord_url||''), esc(store_url||''), esc(announcement||''), maintenance?1:0,
           esc(server_ip||''), esc(server_name||'Blossom SMP'), esc(discord_url||''), esc(store_url||''), esc(announcement||''), maintenance?1:0]);
        return respond({ success: true });
      }

      case 'get_users': {
        const key = body.key || url.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const [rows] = await pool.query(`SELECT id,username,edition,coins,bank,created_at FROM users ORDER BY created_at DESC LIMIT 100`);
        return respond({ users: rows });
      }

      case 'edit_user': {
        const key = body.key || url.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const uid = parseInt(body.user_id || 0);
        const coins = parseInt(body.coins ?? 0);
        const bank = parseFloat(body.bank ?? 0);
        if (!uid) return respond({ error: 'user_id required' }, 400);
        await pool.query(`UPDATE users SET coins=?,bank=? WHERE id=?`, [coins, bank, uid]);
        return respond({ success: true });
      }

      case 'get_site_status': {
        const [rows] = await pool.query(`SELECT * FROM site_settings WHERE id=1 LIMIT 1`).catch(() => [[null]]);
        const settings = rows[0] || { server_name: 'Blossom SMP', server_ip: '', maintenance: 0, announcement: '' };
        return respond({ settings });
      }

      case 'delete_feed': {
        const key = body.key || url.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const feedId = parseInt(body.id || 0);
        if (feedId) {
          await pool.query(`DELETE FROM server_events WHERE id=?`, [feedId]);
        } else {
          await pool.query(`DELETE FROM server_events`);
        }
        return respond({ success: true });
      }

      case 'save_purchase': {
        const token = body.token || '';
        if (!token) return respond({ error: 'token required' }, 400);
        const user = await getUserByToken(pool, token);
        if (!user) return respond({ error: 'Invalid token' }, 401);
        const itemName = esc(body.item_name || 'Unknown Item');
        const itemType = esc(body.item_type || 'Item');
        const price = parseFloat(body.price || 0);
        const giftRecipient = body.gift_recipient ? esc(body.gift_recipient) : null;
        const giftMessage = body.gift_message ? esc(body.gift_message) : null;
        await pool.query(
          `INSERT INTO purchases (user_id, item_name, item_type, price, status, gift_recipient, gift_message) VALUES (?,?,?,?,?,?,?)`,
          [user.id, itemName, itemType, price, 'pending', giftRecipient, giftMessage]
        );
        await pool.query(
          `INSERT INTO server_events (event_type, username, data) VALUES ('purchase', ?, ?)`,
          [user.username, JSON.stringify({ message: itemName, gift_to: giftRecipient })]
        );
        return respond({ success: true });
      }

      case 'mark_delivered': {
        const key = url.searchParams.get('key') || body.key || '';
        if (key !== ADMIN_KEY) return respond({ error: 'Unauthorized' }, 401);
        const pid = parseInt(body.purchase_id || 0);
        if (!pid) return respond({ error: 'purchase_id required' }, 400);
        await pool.query(`UPDATE purchases SET status='delivered',delivered_at=NOW() WHERE id=?`, [pid]);
        return respond({ success: true });
      }

      default:
        return respond({ error: 'Unknown action' }, 400);
    }
  } catch (e) {
    console.error('[BlossomSMP] Error:', e.message);
    return respond({ error: 'Server error: ' + e.message }, 500);
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`[BlossomSMP] API running on port ${PORT}`);
});
