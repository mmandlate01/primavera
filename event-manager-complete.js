// event-manager-complete.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

// Configuração inicial
const app = express();
const PORT = 3000;
const DB_DIR = './databases';
const BACKUP_DIR = './backups';

// Criar diretórios se não existirem
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Banco de dados principal (gerenciamento de eventos e usuários)
const mainDB = new sqlite3.Database(path.join(DB_DIR, 'main.db'));

// Inicializar banco de dados principal
mainDB.serialize(() => {
  mainDB.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'event_manager', 'receptionist', 'consultant')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  mainDB.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('wedding', 'birthday', 'conference', 'baptism', 'other')),
      date DATETIME NOT NULL,
      location TEXT NOT NULL,
      max_guests INTEGER NOT NULL,
      max_tables INTEGER NOT NULL,
      theme_color TEXT DEFAULT '#4a6fa5',
      owner_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(owner_id) REFERENCES users(id)
    )
  `);

  // Inserir usuário admin padrão se não existir
  mainDB.get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'", (err, row) => {
    if (row.count === 0) {
      const hashedPassword = crypto.createHash('sha256').update('admin123').digest('hex');
      mainDB.run(
        "INSERT INTO users (email, password, role) VALUES (?, ?, ?)",
        ['admin@example.com', hashedPassword, 'admin']
      );
    }
  });
});

// Autenticação
function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Rotas de autenticação
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
  
  mainDB.get(
    "SELECT id, email, role FROM users WHERE email = ? AND password = ?",
    [email, hashedPassword],
    (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
      
      const token = Buffer.from(JSON.stringify(user)).toString('base64');
      res.json({ token, user });
    }
  );
});

// Rotas de eventos
app.get('/api/events', authenticate, (req, res) => {
  mainDB.all(
    "SELECT * FROM events WHERE owner_id = ?",
    [req.user.id],
    (err, events) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(events);
    }
  );
});

app.post('/api/events', authenticate, (req, res) => {
  const { name, type, date, location, max_guests, max_tables, theme_color } = req.body;
  
  mainDB.run(
    `INSERT INTO events 
     (name, type, date, location, max_guests, max_tables, theme_color, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, type, date, location, max_guests, max_tables, theme_color || '#4a6fa5', req.user.id],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Criar banco de dados específico para o evento
      const eventDBPath = path.join(DB_DIR, `event_${this.lastID}.db`);
      const eventDB = new sqlite3.Database(eventDBPath);
      
      eventDB.serialize(() => {
        eventDB.run(`
          CREATE TABLE guests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'declined')) DEFAULT 'pending',
            dietary_requirements TEXT,
            validation_code TEXT UNIQUE NOT NULL,
            checked_in BOOLEAN DEFAULT 0,
            check_in_time DATETIME,
            table_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        
        eventDB.run(`
          CREATE TABLE tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            capacity INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('empty', 'partial', 'full')) DEFAULT 'empty',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
      });
      
      eventDB.close();
      
      res.json({ id: this.lastID, message: 'Evento criado com sucesso' });
    }
  );
});

// Middleware para conectar ao banco de dados do evento
function connectEventDB(req, res, next) {
  const eventId = req.params.eventId;
  const eventDBPath = path.join(DB_DIR, `event_${eventId}.db`);
  
  if (!fs.existsSync(eventDBPath)) {
    return res.status(404).json({ error: 'Evento não encontrado' });
  }
  
  req.eventDB = new sqlite3.Database(eventDBPath);
  next();
}

// Rotas para gestão de convidados
app.get('/api/events/:eventId/guests', authenticate, connectEventDB, (req, res) => {
  req.eventDB.all("SELECT * FROM guests", (err, guests) => {
    req.eventDB.close();
    if (err) return res.status(500).json({ error: err.message });
    res.json(guests);
  });
});

app.post('/api/events/:eventId/guests', authenticate, connectEventDB, (req, res) => {
  const { name, email, phone, dietary_requirements } = req.body;
  const validationCode = crypto.randomBytes(8).toString('hex').toUpperCase();
  
  req.eventDB.run(
    `INSERT INTO guests 
     (name, email, phone, dietary_requirements, validation_code)
     VALUES (?, ?, ?, ?, ?)`,
    [name, email || null, phone || null, dietary_requirements || null, validationCode],
    function(err) {
      req.eventDB.close();
      if (err) return res.status(500).json({ error: err.message });
      
      res.json({
        id: this.lastID,
        validationCode,
        message: 'Convidado adicionado com sucesso'
      });
    }
  );
});

// Rotas para gestão de mesas
app.get('/api/events/:eventId/tables', authenticate, connectEventDB, (req, res) => {
  req.eventDB.all("SELECT * FROM tables", (err, tables) => {
    req.eventDB.close();
    if (err) return res.status(500).json({ error: err.message });
    res.json(tables);
  });
});

app.post('/api/events/:eventId/tables', authenticate, connectEventDB, (req, res) => {
  const { name, capacity } = req.body;
  
  req.eventDB.run(
    "INSERT INTO tables (name, capacity) VALUES (?, ?)",
    [name, capacity],
    function(err) {
      req.eventDB.close();
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Mesa criada com sucesso' });
    }
  );
});

// Rota para atribuir convidado a mesa
app.put('/api/events/:eventId/guests/:guestId/assign-table', authenticate, connectEventDB, (req, res) => {
  const { tableId } = req.body;
  
  req.eventDB.run(
    "UPDATE guests SET table_id = ? WHERE id = ?",
    [tableId, req.params.guestId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Atualizar status da mesa
      req.eventDB.get(
        `SELECT COUNT(*) as count FROM guests WHERE table_id = ? AND checked_in = 1`,
        [tableId],
        (err, row) => {
          if (err) {
            req.eventDB.close();
            return res.status(500).json({ error: err.message });
          }
          
          req.eventDB.get(
            "SELECT capacity FROM tables WHERE id = ?",
            [tableId],
            (err, table) => {
              let status = 'partial';
              if (row.count === 0) status = 'empty';
              else if (row.count >= table.capacity) status = 'full';
              
              req.eventDB.run(
                "UPDATE tables SET status = ? WHERE id = ?",
                [status, tableId],
                (err) => {
                  req.eventDB.close();
                  if (err) return res.status(500).json({ error: err.message });
                  res.json({ message: 'Mesa atribuída com sucesso' });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Rota para check-in
app.post('/api/events/:eventId/checkin', connectEventDB, (req, res) => {
  const { code } = req.body;
  
  req.eventDB.get(
    `SELECT g.*, t.name as table_name 
     FROM guests g LEFT JOIN tables t ON g.table_id = t.id 
     WHERE g.validation_code = ?`,
    [code],
    (err, guest) => {
      if (err) {
        req.eventDB.close();
        return res.status(500).json({ error: err.message });
      }
      
      if (!guest) {
        req.eventDB.close();
        return res.json({ valid: false, message: 'Código inválido' });
      }
      
      if (guest.checked_in) {
        req.eventDB.close();
        return res.json({ 
          valid: true, 
          alreadyCheckedIn: true,
          guest: {
            name: guest.name,
            table: guest.table_name
          }
        });
      }
      
      // Marcar check-in
      req.eventDB.run(
        "UPDATE guests SET checked_in = 1, check_in_time = datetime('now') WHERE id = ?",
        [guest.id],
        (err) => {
          if (err) {
            req.eventDB.close();
            return res.status(500).json({ error: err.message });
          }
          
          // Atualizar status da mesa se aplicável
          if (guest.table_id) {
            req.eventDB.get(
              `SELECT COUNT(*) as count FROM guests 
               WHERE table_id = ? AND checked_in = 1`,
              [guest.table_id],
              (err, row) => {
                if (err) {
                  req.eventDB.close();
                  return res.status(500).json({ error: err.message });
                }
                
                req.eventDB.get(
                  "SELECT capacity FROM tables WHERE id = ?",
                  [guest.table_id],
                  (err, table) => {
                    let status = 'partial';
                    if (row.count === 0) status = 'empty';
                    else if (row.count >= table.capacity) status = 'full';
                    
                    req.eventDB.run(
                      "UPDATE tables SET status = ? WHERE id = ?",
                      [status, guest.table_id],
                      (err) => {
                        req.eventDB.close();
                        if (err) return res.status(500).json({ error: err.message });
                        
                        res.json({
                          valid: true,
                          guest: {
                            name: guest.name,
                            table: guest.table_name
                          }
                        });
                      }
                    );
                  }
                );
              }
            );
          } else {
            req.eventDB.close();
            res.json({
              valid: true,
              guest: {
                name: guest.name,
                table: null
              }
            });
          }
        }
      );
    }
  );
});

// Rota para gerar convite PDF
app.get('/api/events/:eventId/guests/:guestId/invite', authenticate, connectEventDB, (req, res) => {
  req.eventDB.get(
    "SELECT g.*, e.name as event_name, e.date, e.location FROM guests g, main.events e WHERE g.id = ? AND e.id = ?",
    [req.params.guestId, req.params.eventId],
    async (err, data) => {
      req.eventDB.close();
      if (err || !data) {
        return res.status(500).json({ error: 'Erro ao gerar convite' });
      }
      
      const doc = new PDFDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=convite_${data.name}.pdf`);
      doc.pipe(res);
      
      // Cabeçalho
      doc.fontSize(20).text(`Convite para ${data.event_name}`, { align: 'center' });
      doc.moveDown();
      
      // QR Code
      try {
        const qrCode = await QRCode.toDataURL(data.validation_code, { width: 150 });
        doc.image(qrCode, doc.page.width / 2 - 75, doc.y, { width: 150 });
        doc.moveDown(3);
      } catch (err) {
        console.error('Erro ao gerar QR Code:', err);
      }
      
      // Detalhes
      doc.fontSize(14).text(`Nome: ${data.name}`);
      doc.text(`Evento: ${data.event_name}`);
      doc.text(`Data: ${new Date(data.date).toLocaleDateString()}`);
      doc.text(`Local: ${data.location}`);
      doc.text(`Código: ${data.validation_code}`);
      
      doc.end();
    }
  );
});

// Rota para backup
app.post('/api/events/:eventId/backup', authenticate, (req, res) => {
  const eventId = req.params.eventId;
  const { password } = req.body;
  const eventDBPath = path.join(DB_DIR, `event_${eventId}.db`);
  const backupFile = path.join(BACKUP_DIR, `event_${eventId}_${Date.now()}.backup`);
  
  if (!fs.existsSync(eventDBPath)) {
    return res.status(404).json({ error: 'Evento não encontrado' });
  }
  
  // Criar cópia do banco de dados
  fs.copyFileSync(eventDBPath, backupFile);
  
  // Criptografar
  const cipher = crypto.createCipher('aes-256-cbc', password);
  const input = fs.createReadStream(backupFile);
  const output = fs.createWriteStream(`${backupFile}.enc`);
  
  input.pipe(cipher).pipe(output);
  
  output.on('finish', () => {
    fs.unlinkSync(backupFile);
    res.json({ 
      message: 'Backup criado com sucesso',
      file: `${backupFile}.enc`
    });
  });
});

// Rota para restaurar backup
app.post('/api/events/:eventId/restore', authenticate, (req, res) => {
  const eventId = req.params.eventId;
  const { file, password } = req.body;
  const backupFile = path.join(BACKUP_DIR, file);
  const decryptedFile = path.join(BACKUP_DIR, `temp_${Date.now()}.db`);
  
  if (!fs.existsSync(backupFile)) {
    return res.status(404).json({ error: 'Arquivo de backup não encontrado' });
  }
  
  // Descriptografar
  const decipher = crypto.createDecipher('aes-256-cbc', password);
  const input = fs.createReadStream(backupFile);
  const output = fs.createWriteStream(decryptedFile);
  
  input.pipe(decipher).pipe(output);
  
  output.on('finish', () => {
    // Substituir banco de dados atual
    const eventDBPath = path.join(DB_DIR, `event_${eventId}.db`);
    fs.copyFileSync(decryptedFile, eventDBPath);
    fs.unlinkSync(decryptedFile);
    
    res.json({ message: 'Backup restaurado com sucesso' });
  });
});

// Frontend HTML
const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Event Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { background: #333; color: #fff; padding: 20px 0; margin-bottom: 30px; }
    header h1 { text-align: center; }
    .auth-form { max-width: 400px; margin: 50px auto; padding: 20px; border: 1px solid #ddd; border-radius: 5px; }
    .auth-form h2 { margin-bottom: 20px; text-align: center; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; }
    .form-group input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
    button { background: #333; color: #fff; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #555; }
    .dashboard { display: grid; grid-template-columns: 250px 1fr; gap: 20px; }
    .sidebar { background: #f4f4f4; padding: 20px; border-radius: 5px; }
    .main-content { padding: 20px; }
    .event-card { border: 1px solid #ddd; border-radius: 5px; padding: 15px; margin-bottom: 15px; }
    .event-card h3 { margin-bottom: 10px; }
    .tab-container { margin-top: 20px; }
    .tab-buttons { display: flex; border-bottom: 1px solid #ddd; }
    .tab-button { padding: 10px 20px; background: none; border: none; cursor: pointer; }
    .tab-button.active { border-bottom: 2px solid #333; font-weight: bold; }
    .tab-content { padding: 20px 0; display: none; }
    .tab-content.active { display: block; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    table th, table td { padding: 10px; border: 1px solid #ddd; text-align: left; }
    table th { background: #f4f4f4; }
    .checkin-container { max-width: 600px; margin: 0 auto; text-align: center; }
    .checkin-result { margin-top: 20px; padding: 20px; border-radius: 5px; }
    .valid { background: #d4edda; color: #155724; }
    .invalid { background: #f8d7da; color: #721c24; }
    @media (max-width: 768px) {
      .dashboard { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <h1>Event Manager</h1>
    </header>
    
    <div class="container">
      <!-- Página de Login -->
      <div id="login-page" class="auth-form">
        <h2>Login</h2>
        <div class="form-group">
          <label for="login-email">Email</label>
          <input type="email" id="login-email" placeholder="Seu email">
        </div>
        <div class="form-group">
          <label for="login-password">Senha</label>
          <input type="password" id="login-password" placeholder="Sua senha">
        </div>
        <button id="login-btn">Entrar</button>
      </div>
      
      <!-- Dashboard -->
      <div id="dashboard" style="display: none;">
        <div class="dashboard">
          <div class="sidebar">
            <h3>Meus Eventos</h3>
            <ul id="event-list"></ul>
            <button id="create-event-btn">Criar Novo Evento</button>
          </div>
          
          <div class="main-content">
            <h2 id="event-title"></h2>
            
            <div class="tab-container">
              <div class="tab-buttons">
                <button class="tab-button active" data-tab="guests">Convidados</button>
                <button class="tab-button" data-tab="tables">Mesas</button>
                <button class="tab-button" data-tab="checkin">Check-in</button>
                <button class="tab-button" data-tab="reports">Relatórios</button>
                <button class="tab-button" data-tab="backup">Backup</button>
              </div>
              
              <div id="guests" class="tab-content active">
                <h3>Lista de Convidados</h3>
                <button id="add-guest-btn">Adicionar Convidado</button>
                <table id="guest-table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Email</th>
                      <th>Status</th>
                      <th>Mesa</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody></tbody>
                </table>
              </div>
              
              <div id="tables" class="tab-content">
                <h3>Mesas</h3>
                <button id="add-table-btn">Adicionar Mesa</button>
                <table id="table-table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>Capacidade</th>
                      <th>Status</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody></tbody>
                </table>
              </div>
              
              <div id="checkin" class="tab-content">
                <div class="checkin-container">
                  <h3>Check-in de Convidados</h3>
                  <div class="form-group">
                    <input type="text" id="checkin-code" placeholder="Digite o código ou escaneie o QR">
                  </div>
                  <button id="checkin-btn">Verificar</button>
                  <div id="checkin-result" class="checkin-result" style="display: none;"></div>
                </div>
              </div>
              
              <div id="reports" class="tab-content">
                <h3>Relatórios</h3>
                <div id="report-stats">
                  <p>Total de convidados: <span id="total-guests">0</span></p>
                  <p>Confirmados: <span id="confirmed-guests">0</span></p>
                  <p>Check-ins: <span id="checked-in-guests">0</span></p>
                  <p>Ocupação de mesas: <span id="tables-occupancy">0%</span></p>
                </div>
              </div>
              
              <div id="backup" class="tab-content">
                <h3>Backup e Restauração</h3>
                <div class="form-group">
                  <label for="backup-password">Senha para backup</label>
                  <input type="password" id="backup-password" placeholder="Digite uma senha segura">
                </div>
                <button id="create-backup-btn">Criar Backup</button>
                
                <h4 style="margin-top: 30px;">Restaurar Backup</h4>
                <div class="form-group">
                  <label for="restore-file">Arquivo de backup</label>
                  <input type="file" id="restore-file">
                </div>
                <div class="form-group">
                  <label for="restore-password">Senha do backup</label>
                  <input type="password" id="restore-password" placeholder="Digite a senha do backup">
                </div>
                <button id="restore-backup-btn">Restaurar Backup</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Estado da aplicação
    let state = {
      token: null,
      user: null,
      currentEvent: null,
      events: [],
      guests: [],
      tables: []
    };

    // Elementos DOM
    const loginPage = document.getElementById('login-page');
    const dashboard = document.getElementById('dashboard');
    const loginEmail = document.getElementById('login-email');
    const loginPassword = document.getElementById('login-password');
    const loginBtn = document.getElementById('login-btn');
    const eventList = document.getElementById('event-list');
    const eventTitle = document.getElementById('event-title');
    const createEventBtn = document.getElementById('create-event-btn');
    const guestTable = document.getElementById('guest-table').querySelector('tbody');
    const addGuestBtn = document.getElementById('add-guest-btn');
    const tableTable = document.getElementById('table-table').querySelector('tbody');
    const addTableBtn = document.getElementById('add-table-btn');
    const checkinCode = document.getElementById('checkin-code');
    const checkinBtn = document.getElementById('checkin-btn');
    const checkinResult = document.getElementById('checkin-result');
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    const backupPassword = document.getElementById('backup-password');
    const createBackupBtn = document.getElementById('create-backup-btn');
    const restoreFile = document.getElementById('restore-file');
    const restorePassword = document.getElementById('restore-password');
    const restoreBackupBtn = document.getElementById('restore-backup-btn');
    const reportStats = document.getElementById('report-stats');

    // Funções auxiliares
    function showError(message) {
      alert('Erro: ' + message);
    }

    function apiRequest(url, method = 'GET', data = null) {
      const headers = {
        'Content-Type': 'application/json'
      };
      
      if (state.token) {
        headers['Authorization'] = 'Bearer ' + state.token;
      }
      
      return fetch(url, {
        method,
        headers,
        body: data ? JSON.stringify(data) : null
      })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => {
            throw new Error(err.error || 'Erro na requisição');
          });
        }
        return response.json();
      });
    }

    // Tabs
    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        const tabId = button.getAttribute('data-tab');
        
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        
        button.classList.add('active');
        document.getElementById(tabId).classList.add('active');
        
        if (tabId === 'guests') loadGuests();
        if (tabId === 'tables') loadTables();
        if (tabId === 'reports') loadReports();
      });
    });

    // Login
    loginBtn.addEventListener('click', () => {
      const email = loginEmail.value;
      const password = loginPassword.value;
      
      if (!email || !password) {
        return showError('Email e senha são obrigatórios');
      }
      
      apiRequest('/api/login', 'POST', { email, password })
        .then(data => {
          state.token = data.token;
          state.user = data.user;
          
          loginPage.style.display = 'none';
          dashboard.style.display = 'block';
          
          loadEvents();
        })
        .catch(showError);
    });

    // Eventos
    function loadEvents() {
      apiRequest('/api/events')
        .then(events => {
          state.events = events;
          renderEvents();
        })
        .catch(showError);
    }

    function renderEvents() {
      eventList.innerHTML = '';
      
      state.events.forEach(event => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = event.name;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          selectEvent(event);
        });
        
        li.appendChild(a);
        eventList.appendChild(li);
      });
    }

    function selectEvent(event) {
      state.currentEvent = event;
      eventTitle.textContent = event.name;
      loadGuests();
      loadTables();
    }

    createEventBtn.addEventListener('click', () => {
      const name = prompt('Nome do evento:');
      if (!name) return;
      
      const type = prompt('Tipo (wedding, birthday, conference, baptism):');
      if (!type) return;
      
      const date = prompt('Data (YYYY-MM-DD):');
      if (!date) return;
      
      const location = prompt('Local:');
      if (!location) return;
      
      const maxGuests = prompt('Número máximo de convidados:');
      if (!maxGuests) return;
      
      const maxTables = prompt('Número máximo de mesas:');
      if (!maxTables) return;
      
      apiRequest('/api/events', 'POST', {
        name,
        type,
        date,
        location,
        max_guests: parseInt(maxGuests),
        max_tables: parseInt(maxTables)
      })
      .then(() => {
        loadEvents();
      })
      .catch(showError);
    });

    // Convidados
    function loadGuests() {
      if (!state.currentEvent) return;
      
      apiRequest('/api/events/' + state.currentEvent.id + '/guests')
        .then(guests => {
          state.guests = guests;
          renderGuests();
        })
        .catch(showError);
    }

    function renderGuests() {
      guestTable.innerHTML = '';
      
      state.guests.forEach(guest => {
        const tr = document.createElement('tr');
        
        tr.innerHTML = '<td>' + guest.name + '</td>' +
          '<td>' + (guest.email || '-') + '</td>' +
          '<td>' + guest.status + '</td>' +
          '<td>' + (guest.table_id || '-') + '</td>' +
          '<td>' +
          '<button class="assign-table-btn" data-guest-id="' + guest.id + '">Atribuir Mesa</button>' +
          '<a href="/api/events/' + state.currentEvent.id + '/guests/' + guest.id + '/invite" target="_blank">Convite</a>' +
          '</td>';
        
        guestTable.appendChild(tr);
      });
      
      // Adicionar eventos aos botões de atribuir mesa
      document.querySelectorAll('.assign-table-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const guestId = btn.getAttribute('data-guest-id');
          assignTable(guestId);
        });
      });
    }

    function assignTable(guestId) {
      if (!state.tables.length) {
        return showError('Primeiro crie algumas mesas');
      }
      
      const tableOptions = state.tables.map((table, index) => 
        index + ': ' + table.name + ' (' + table.capacity + ' lugares, ' + table.status + ')'
      ).join('\n');
      
      const tableIndex = prompt('Escolha a mesa (0-' + (state.tables.length-1) + '):\n' + tableOptions);
      if (tableIndex === null) return;
      
      const tableId = state.tables[parseInt(tableIndex)]?.id;
      if (!tableId) return;
      
      apiRequest(
        '/api/events/' + state.currentEvent.id + '/guests/' + guestId + '/assign-table',
        'PUT',
        { tableId }
      )
      .then(() => {
        loadGuests();
        loadTables();
      })
      .catch(showError);
    }

    addGuestBtn.addEventListener('click', () => {
      const name = prompt('Nome do convidado:');
      if (!name) return;
      
      const email = prompt('Email (opcional):');
      const phone = prompt('Telefone (opcional):');
      const dietary = prompt('Restrições alimentares (opcional):');
      
      apiRequest('/api/events/' + state.currentEvent.id + '/guests', 'POST', {
        name,
        email,
        phone,
        dietary_requirements: dietary
      })
      .then(() => {
        loadGuests();
      })
      .catch(showError);
    });

    // Mesas
    function loadTables() {
      if (!state.currentEvent) return;
      
      apiRequest('/api/events/' + state.currentEvent.id + '/tables')
        .then(tables => {
          state.tables = tables;
          renderTables();
        })
        .catch(showError);
    }

    function renderTables() {
      tableTable.innerHTML = '';
      
      state.tables.forEach(table => {
        const tr = document.createElement('tr');
        
        tr.innerHTML = '<td>' + table.name + '</td>' +
          '<td>' + table.capacity + '</td>' +
          '<td>' + table.status + '</td>' +
          '<td>' +
          '<button class="view-guests-btn" data-table-id="' + table.id + '">Ver Convidados</button>' +
          '</td>';
        
        tableTable.appendChild(tr);
      });
      
      // Adicionar eventos aos botões de ver convidados
      document.querySelectorAll('.view-guests-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const tableId = btn.getAttribute('data-table-id');
          viewTableGuests(tableId);
        });
      });
    }

    function viewTableGuests(tableId) {
      const guests = state.guests.filter(g => g.table_id == tableId);
      if (!guests.length) {
        return alert('Nenhum convidado nesta mesa');
      }
      
      alert(guests.map(g => g.name).join('\n'));
    }

    addTableBtn.addEventListener('click', () => {
      const name = prompt('Nome da mesa:');
      if (!name) return;
      
      const capacity = prompt('Capacidade:');
      if (!capacity) return;
      
      apiRequest('/api/events/' + state.currentEvent.id + '/tables', 'POST', {
        name,
        capacity: parseInt(capacity)
      })
      .then(() => {
        loadTables();
      })
      .catch(showError);
    });

    // Check-in
    checkinBtn.addEventListener('click', () => {
      const code = checkinCode.value.trim();
      if (!code) return;
      
      apiRequest('/api/events/' + state.currentEvent.id + '/checkin', 'POST', { code })
        .then(data => {
          checkinResult.style.display = 'block';
          checkinResult.className = 'checkin-result';
          
          if (data.valid) {
            checkinResult.classList.add('valid');
            
            if (data.alreadyCheckedIn) {
              checkinResult.innerHTML = '<h3>Convidado já fez check-in</h3>' +
                '<p><strong>Nome:</strong> ' + data.guest.name + '</p>' +
                '<p><strong>Mesa:</strong> ' + (data.guest.table || 'Não atribuída') + '</p>';
            } else {
              checkinResult.innerHTML = '<h3>Check-in confirmado!</h3>' +
                '<p><strong>Nome:</strong> ' + data.guest.name + '</p>' +
                '<p><strong>Mesa:</strong> ' + (data.guest.table || 'Não atribuída') + '</p>';
            }
          } else {
            checkinResult.classList.add('invalid');
            checkinResult.innerHTML = '<h3>Código inválido</h3><p>' + data.message + '</p>';
          }
          
          loadGuests();
          loadTables();
          loadReports();
        })
        .catch(showError);
    });

    // Relatórios
    function loadReports() {
      if (!state.currentEvent) return;
      
      const totalGuests = state.guests.length;
      const confirmedGuests = state.guests.filter(g => g.status === 'confirmed').length;
      const checkedInGuests = state.guests.filter(g => g.checked_in).length;
      
      let occupancy = 0;
      if (state.tables.length) {
        const totalCapacity = state.tables.reduce((sum, table) => sum + table.capacity, 0);
        const usedCapacity = state.guests.filter(g => g.table_id).length;
        occupancy = Math.round((usedCapacity / totalCapacity) * 100);
      }
      
      document.getElementById('total-guests').textContent = totalGuests;
      document.getElementById('confirmed-guests').textContent = confirmedGuests;
      document.getElementById('checked-in-guests').textContent = checkedInGuests;
      document.getElementById('tables-occupancy').textContent = occupancy + '%';
    }

    // Backup
    createBackupBtn.addEventListener('click', () => {
      const password = backupPassword.value;
      if (!password) {
        return showError('Digite uma senha para o backup');
      }
      
      apiRequest('/api/events/' + state.currentEvent.id + '/backup', 'POST', { password })
        .then(data => {
          alert('Backup criado com sucesso: ' + data.file);
        })
        .catch(showError);
    });

    restoreBackupBtn.addEventListener('click', () => {
      const file = restoreFile.files[0];
      const password = restorePassword.value;
      
      if (!file || !password) {
        return showError('Selecione um arquivo e digite a senha');
      }
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('password', password);
      
      fetch('/api/events/' + state.currentEvent.id + '/restore', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + state.token
        },
        body: formData
      })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => {
            throw new Error(err.error || 'Erro na restauração');
          });
        }
        return response.json();
      })
      .then(() => {
        alert('Backup restaurado com sucesso');
        loadGuests();
        loadTables();
      })
      .catch(showError);
    });

    // Inicialização
    if (window.location.hash === '#debug') {
      loginEmail.value = 'admin@example.com';
      loginPassword.value = 'admin123';
    }
  </script>
</body>
</html>
`;

// Rota para servir o frontend
app.get('/', (req, res) => {
  res.send(FRONTEND_HTML);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  console.log('Use admin@example.com / admin123 para login');
});