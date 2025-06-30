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

// Rota para servir o frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log('Servidor rodando em http://localhost:' + PORT);
  console.log('Use admin@example.com / admin123 para login');
});
