const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = 'school-secret-key';
const DB_FILE = path.join(__dirname, 'school.db');

app.use(express.json());

const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','director','teacher','student','parent')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    guardian_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    qualification TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    teacher_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
  )`);
});

function generateToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '2h' });
}

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).json({ error: 'Token missing' });
    const token = header.split(' ')[1];
    try {
      const payload = jwt.verify(token, SECRET);
      req.user = payload;
      if (requiredRoles.length && !requiredRoles.includes(payload.role)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

app.post('/api/register', (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) return res.status(400).json({ error: 'Missing fields' });
  const hashed = bcrypt.hashSync(password, 8);
  db.run(
    'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
    [email, hashed, role],
    function (err) {
      if (err) return res.status(400).json({ error: 'User exists' });
      res.json({ id: this.lastID });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateToken(user);
    res.json({ token });
  });
});

// Students CRUD
app.get('/api/students', auth(['admin','director','teacher']), (req, res) => {
  db.all('SELECT * FROM students', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/students', auth(['admin','director']), (req, res) => {
  const { name, email, guardian_email } = req.body;
  db.run(
    'INSERT INTO students (name, email, guardian_email) VALUES (?,?,?)',
    [name, email || null, guardian_email || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// Teachers CRUD
app.get('/api/teachers', auth(['admin','director']), (req, res) => {
  db.all('SELECT * FROM teachers', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/teachers', auth(['admin','director']), (req, res) => {
  const { name, email, qualification } = req.body;
  db.run(
    'INSERT INTO teachers (name, email, qualification) VALUES (?,?,?)',
    [name, email || null, qualification || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

// Classes management
app.get('/api/classes', auth(['admin','director','teacher']), (req, res) => {
  db.all('SELECT c.id,c.name,t.name as teacher FROM classes c LEFT JOIN teachers t ON c.teacher_id=t.id', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/classes', auth(['admin','director']), (req, res) => {
  const { name, teacher_id } = req.body;
  db.run('INSERT INTO classes (name, teacher_id) VALUES (?,?)', [name, teacher_id || null], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

app.listen(PORT, () => {
  console.log('School management API on port ' + PORT);
});
