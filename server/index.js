const express     = require('express');
const initSqlJs   = require('sql.js');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const cookieParser= require('cookie-parser');
const path        = require('path');
const fs          = require('fs');
const cors        = require('cors');
const multer      = require('multer');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'masar-secret-2025';
const DB_PATH    = path.join(__dirname, 'masar.db');
const UPLOADS_DIR = path.join(__dirname, '../uploads');

// Create uploads dir if not exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer config for file uploads
var storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, UPLOADS_DIR); },
  filename: function(req, file, cb) {
    var ext = path.extname(file.originalname);
    cb(null, 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2,6) + ext);
  }
});
var upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: function(req, file, cb) {
    var allowed = ['.zip', '.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.pdf'];
    var ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('نوع الملف غير مسموح'));
  }
});

let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      field TEXT DEFAULT '',
      joined_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id TEXT NOT NULL,
      field TEXT DEFAULT '',
      sub_field TEXT DEFAULT '',
      watched_seconds INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      last_watched TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id TEXT NOT NULL,
      timestamp_sec INTEGER DEFAULT 0,
      note TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS saved_courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id TEXT NOT NULL,
      UNIQUE(user_id, course_id)
    );
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id TEXT NOT NULL,
      course_title TEXT,
      field TEXT,
      level TEXT,
      duration TEXT,
      issued_at TEXT DEFAULT (datetime('now')),
      cert_code TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id TEXT NOT NULL,
      course_title TEXT NOT NULL,
      field TEXT NOT NULL,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      github_url TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      file_name TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      admin_note TEXT DEFAULT '',
      score INTEGER DEFAULT 0,
      submitted_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS notebooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS learning_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      seconds INTEGER DEFAULT 0,
      UNIQUE(user_id, date)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      course_id TEXT NOT NULL,
      content TEXT NOT NULL,
      likes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comment_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      UNIQUE(user_id, comment_id)
    );
  `);
  saveDB();
  console.log('✅ Database ready');
}

function saveDB() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbGet(sql, p) {
  p = p || [];
  var s = db.prepare(sql);
  s.bind(p);
  var r = s.step() ? s.getAsObject() : null;
  s.free();
  return r;
}

function dbAll(sql, p) {
  p = p || [];
  var s = db.prepare(sql);
  s.bind(p);
  var r = [];
  while (s.step()) r.push(s.getAsObject());
  s.free();
  return r;
}

function dbRun(sql, p) {
  p = p || [];
  db.run(sql, p);
  saveDB();
  var r = db.exec('SELECT last_insert_rowid() as id');
  return r[0] ? r[0].values[0][0] : null;
}

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Serve everything from the root folder (flat structure)
app.use(express.static(path.join(__dirname, '..')));

function auth(req, res, next) {
  var token = req.cookies.masar_token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'الجلسة منتهية' });
  }
}

// ─── AUTH ─────────────────────────────────────────────────
app.post('/api/auth/register', function(req, res) {
  var name     = req.body.name;
  var email    = req.body.email;
  var password = req.body.password;
  var field    = req.body.field || '';
  if (!name || !name.trim() || !email || !email.trim() || !password)
    return res.status(400).json({ error: 'كل الحقول مطلوبة' });
  if (password.length < 6)
    return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  if (email.indexOf('@') === -1)
    return res.status(400).json({ error: 'بريد إلكتروني غير صحيح' });
  if (dbGet('SELECT id FROM users WHERE email=?', [email.toLowerCase()]))
    return res.status(409).json({ error: 'البريد مسجّل بالفعل' });
  var hashed = bcrypt.hashSync(password, 10);
  var id = dbRun('INSERT INTO users (name,email,password,field) VALUES (?,?,?,?)',
    [name.trim(), email.toLowerCase(), hashed, field]);
  var user  = { id: id, name: name.trim(), email: email.toLowerCase(), field: field };
  var token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('masar_token', token, { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: 'lax' });
  res.json({ success: true, user: user, token: token });
});

app.post('/api/auth/login', function(req, res) {
  var email    = req.body.email;
  var password = req.body.password;
  if (!email || !password)
    return res.status(400).json({ error: 'ادخل البريد وكلمة المرور' });
  var user = dbGet('SELECT * FROM users WHERE email=?', [email.toLowerCase()]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'البريد أو كلمة المرور غلط' });
  var payload = { id: user.id, name: user.name, email: user.email, field: user.field };
  var token   = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('masar_token', token, { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: 'lax' });
  res.json({ success: true, user: payload, token: token });
});

app.post('/api/auth/logout', function(req, res) {
  res.clearCookie('masar_token');
  res.json({ success: true });
});

app.get('/api/auth/me', auth, function(req, res) {
  var user = dbGet('SELECT id,name,email,field,joined_at FROM users WHERE id=?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'المستخدم مش موجود' });
  res.json({
    id:        user.id,
    name:      user.name,
    email:     user.email,
    field:     user.field,
    joined_at: user.joined_at,
    stats: {
      courses:   dbGet('SELECT COUNT(*) as c FROM progress WHERE user_id=?',              [req.user.id]).c || 0,
      completed: dbGet('SELECT COUNT(*) as c FROM progress WHERE user_id=? AND completed=1',[req.user.id]).c || 0,
      certs:     dbGet('SELECT COUNT(*) as c FROM certificates WHERE user_id=?',           [req.user.id]).c || 0,
      saved:     dbGet('SELECT COUNT(*) as c FROM saved_courses WHERE user_id=?',          [req.user.id]).c || 0,
    }
  });
});

// ─── PROGRESS ─────────────────────────────────────────────
app.get('/api/progress', auth, function(req, res) {
  res.json(dbAll('SELECT * FROM progress WHERE user_id=? ORDER BY last_watched DESC', [req.user.id]));
});

app.post('/api/progress', auth, function(req, res) {
  var cid  = req.body.course_id;
  var fld  = req.body.field     || '';
  var sub  = req.body.sub_field || '';
  var secs = req.body.watched_seconds || 0;
  var done = req.body.completed ? 1 : 0;
  var ex   = dbGet('SELECT id FROM progress WHERE user_id=? AND course_id=?', [req.user.id, cid]);
  if (ex) {
    dbRun('UPDATE progress SET watched_seconds=MAX(watched_seconds,?),completed=MAX(completed,?),last_watched=datetime("now") WHERE user_id=? AND course_id=?',
      [secs, done, req.user.id, cid]);
  } else {
    dbRun('INSERT INTO progress (user_id,course_id,field,sub_field,watched_seconds,completed) VALUES (?,?,?,?,?,?)',
      [req.user.id, cid, fld, sub, secs, done]);
  }
  res.json({ success: true });
});

// ─── NOTES ────────────────────────────────────────────────
app.get('/api/notes/:id', auth, function(req, res) {
  res.json(dbAll('SELECT * FROM notes WHERE user_id=? AND course_id=? ORDER BY id ASC', [req.user.id, req.params.id]));
});

app.post('/api/notes', auth, function(req, res) {
  var cid  = req.body.course_id;
  var ts   = req.body.timestamp_sec || 0;
  var note = req.body.note;
  if (!cid || !note || !note.trim()) return res.status(400).json({ error: 'بيانات ناقصة' });
  var id = dbRun('INSERT INTO notes (user_id,course_id,timestamp_sec,note) VALUES (?,?,?,?)',
    [req.user.id, cid, ts, note.trim()]);
  res.json({ success: true, id: id });
});

app.delete('/api/notes/:id', auth, function(req, res) {
  dbRun('DELETE FROM notes WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// ─── SAVED ────────────────────────────────────────────────
app.get('/api/saved', auth, function(req, res) {
  res.json(dbAll('SELECT course_id FROM saved_courses WHERE user_id=?', [req.user.id]).map(function(r){ return r.course_id; }));
});

app.post('/api/saved/toggle', auth, function(req, res) {
  var cid = req.body.course_id;
  var ex  = dbGet('SELECT id FROM saved_courses WHERE user_id=? AND course_id=?', [req.user.id, cid]);
  if (ex) {
    dbRun('DELETE FROM saved_courses WHERE user_id=? AND course_id=?', [req.user.id, cid]);
    res.json({ saved: false });
  } else {
    dbRun('INSERT OR IGNORE INTO saved_courses (user_id,course_id) VALUES (?,?)', [req.user.id, cid]);
    res.json({ saved: true });
  }
});

// ─── CERTIFICATES ─────────────────────────────────────────
app.get('/api/certificates', auth, function(req, res) {
  res.json(dbAll('SELECT * FROM certificates WHERE user_id=? ORDER BY issued_at DESC', [req.user.id]));
});

app.post('/api/certificates/issue', auth, function(req, res) {
  var cid   = req.body.course_id;
  var title = req.body.course_title;
  var fld   = req.body.field;
  var lvl   = req.body.level;
  var dur   = req.body.duration;
  if (dbGet('SELECT id FROM certificates WHERE user_id=? AND course_id=?', [req.user.id, cid]))
    return res.json({ success: true, already: true });
  var code = 'MSR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2,4).toUpperCase();
  dbRun('INSERT INTO certificates (user_id,course_id,course_title,field,level,duration,cert_code) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, cid, title, fld, lvl, dur, code]);
  res.json({ success: true, cert_code: code });
});

// ─── PROFILE ──────────────────────────────────────────────
app.put('/api/profile', auth, function(req, res) {
  var name  = req.body.name;
  var field = req.body.field || '';
  if (!name || !name.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
  dbRun('UPDATE users SET name=?,field=? WHERE id=?', [name.trim(), field, req.user.id]);
  res.json({ success: true });
});

// ─── FALLBACK ─────────────────────────────────────────────
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── PROJECTS ─────────────────────────────────────────────

// Submit project
app.post('/api/projects', auth, upload.single('file'), function(req, res) {
  var title       = req.body.title;
  var description = req.body.description || '';
  var github_url  = req.body.github_url  || '';
  var course_id   = req.body.course_id;
  var course_title= req.body.course_title;
  var field       = req.body.field;
  var level       = req.body.level;

  if (!title || !title.trim())      return res.status(400).json({ error: 'عنوان المشروع مطلوب' });
  if (!course_id)                   return res.status(400).json({ error: 'course_id مطلوب' });
  if (!github_url && !req.file)     return res.status(400).json({ error: 'ارفع ملف أو اكتب رابط GitHub' });

  var file_path = req.file ? '/uploads/' + req.file.filename : '';
  var file_name = req.file ? req.file.originalname : '';

  dbRun(
    'INSERT INTO projects (user_id,course_id,course_title,field,level,title,description,github_url,file_path,file_name) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [req.user.id, course_id, course_title, field, level, title.trim(), description, github_url, file_path, file_name]
  );
  res.json({ success: true, message: 'تم رفع مشروعك بنجاح! سيتم مراجعته قريباً' });
});

// Get my projects
app.get('/api/projects', auth, function(req, res) {
  res.json(dbAll('SELECT * FROM projects WHERE user_id=? ORDER BY submitted_at DESC', [req.user.id]));
});

// ─── ADMIN PROJECTS ───────────────────────────────────────

// Get all projects (admin)
app.get('/api/admin/projects', auth, function(req, res) {
  var projects = dbAll(
    'SELECT p.*, u.name as user_name, u.email as user_email FROM projects p JOIN users u ON p.user_id=u.id ORDER BY p.submitted_at DESC',
    []
  );
  res.json(projects);
});

// Review project (admin)
app.put('/api/admin/projects/:id', auth, function(req, res) {
  var status     = req.body.status;
  var admin_note = req.body.admin_note || '';
  var score      = req.body.score || 0;
  if (!['pending','approved','rejected','needs_revision'].includes(status))
    return res.status(400).json({ error: 'status غير صحيح' });
  dbRun(
    'UPDATE projects SET status=?,admin_note=?,score=?,reviewed_at=datetime("now") WHERE id=?',
    [status, admin_note, score, req.params.id]
  );
  res.json({ success: true });
});

// ─── GEMINI HELPER ────────────────────────────────────────
var GEMINI_KEY = process.env.GEMINI_KEY || 'AIzaSyAImgbGRuS7hhm1ZAE6JIvmuLJD_SlMtw8';

async function geminiAsk(prompt) {
  if (!GEMINI_KEY) throw new Error('GEMINI_KEY غير موجود');
  var https = require('https');
  var body  = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
  });
  return new Promise(function(resolve, reject) {
    var options = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(r) {
      var data = '';
      r.on('data', function(c) { data += c; });
      r.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          console.log('Gemini response:', JSON.stringify(parsed).slice(0, 300));
          var text = parsed.candidates && parsed.candidates[0]
            ? parsed.candidates[0].content.parts[0].text
            : (parsed.error ? parsed.error.message : 'عذراً، لم أستطع الرد');
          resolve(text);
        } catch(e) { reject(new Error('خطأ في معالجة الرد')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 1. CHATBOT المساعد التعليمي ─────────────────────────
app.post('/api/chat', auth, async function(req, res) {
  var message    = req.body.message;
  var courseName = req.body.course || '';
  if (!message || !message.trim()) return res.status(400).json({ error: 'اكتب رسالة' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'المساعد الذكي مش متاح دلوقتي' });
  try {
    var prompt = 'أنت مساعد تعليمي لمنصة مَسار العربية. ' +
      (courseName ? 'الطالب بيدرس كورس: ' + courseName + '. ' : '') +
      'أجب على سؤال الطالب بالعربية بشكل واضح ومختصر ومفيد. لو السؤال عن كود، اشرحه بأمثلة.\n\nسؤال الطالب: ' + message.trim();
    var reply = await geminiAsk(prompt);
    res.json({ reply: reply });
  } catch(e) { res.status(500).json({ error: e.message || 'خطأ في السيرفر' }); }
});

// ─── 2. شرح الكود ────────────────────────────────────────
app.post('/api/explain-code', auth, async function(req, res) {
  var code = req.body.code;
  var lang = req.body.language || 'JavaScript';
  if (!code || !code.trim()) return res.status(400).json({ error: 'ادخل الكود' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'الخدمة مش متاحة دلوقتي' });
  try {
    var prompt = 'اشرح الكود ده بالعربية بشكل بسيط وواضح خطوة خطوة. اللغة: ' + lang + '\n\nالكود:\n```\n' + code.trim() + '\n```\n\nالشرح:';
    var reply = await geminiAsk(prompt);
    res.json({ explanation: reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── 3. اختبار ذكي ──────────────────────────────────────
app.post('/api/generate-quiz', auth, async function(req, res) {
  var topic = req.body.topic;
  var level = req.body.level || 'مبتدئ';
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'ادخل الموضوع' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'الخدمة مش متاحة دلوقتي' });
  try {
    var prompt = 'اعمل 5 أسئلة اختيار متعدد عن موضوع "' + topic + '" للمستوى ' + level + '.\n' +
      'الرد لازم يكون JSON فقط بالشكل ده:\n' +
      '{"questions":[{"q":"السؤال","options":["أ","ب","ج","د"],"answer":0,"explain":"الشرح"}]}\n' +
      'answer هو index الإجابة الصحيحة (0-3). الأسئلة بالعربية.';
    var reply = await geminiAsk(prompt);
    // Extract JSON from response
    var match = reply.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('فشل في توليد الأسئلة');
    var quizData = JSON.parse(match[0]);
    res.json(quizData);
  } catch(e) { res.status(500).json({ error: 'فشل في توليد الأسئلة — حاول تاني' }); }
});

// ─── 4. ملخص الكورس ─────────────────────────────────────
app.post('/api/summarize', auth, async function(req, res) {
  var topic = req.body.topic;
  var course = req.body.course || '';
  if (!topic || !topic.trim()) return res.status(400).json({ error: 'ادخل الموضوع' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'الخدمة مش متاحة دلوقتي' });
  try {
    var prompt = 'اعمل ملخص تعليمي مختصر بالعربية عن موضوع "' + topic + '"' +
      (course ? ' في سياق كورس ' + course : '') +
      '. الملخص يشمل: أهم المفاهيم، فائدته العملية، ونصيحة للطالب. بشكل نقاط واضحة.';
    var reply = await geminiAsk(prompt);
    res.json({ summary: reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── NOTEBOOK (NotebookLM style) ─────────────────────────
app.get('/api/notebooks', auth, function(req, res) {
  res.json(dbAll('SELECT * FROM notebooks WHERE user_id=? ORDER BY updated_at DESC', [req.user.id]));
});

app.post('/api/notebooks', auth, function(req, res) {
  var title   = req.body.title || 'ملاحظة جديدة';
  var content = req.body.content || '';
  var id = dbRun('INSERT INTO notebooks (user_id,title,content) VALUES (?,?,?)', [req.user.id, title, content]);
  res.json({ success: true, id: id });
});

app.put('/api/notebooks/:id', auth, function(req, res) {
  var title   = req.body.title;
  var content = req.body.content;
  dbRun('UPDATE notebooks SET title=?,content=?,updated_at=datetime("now") WHERE id=? AND user_id=?',
    [title, content, req.params.id, req.user.id]);
  res.json({ success: true });
});

app.delete('/api/notebooks/:id', auth, function(req, res) {
  dbRun('DELETE FROM notebooks WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// Chat with notebook content using Gemini
app.post('/api/notebooks/:id/chat', auth, async function(req, res) {
  var message = req.body.message;
  if (!message || !message.trim()) return res.status(400).json({ error: 'اكتب سؤالك' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'المساعد الذكي مش متاح' });
  var notebook = dbGet('SELECT * FROM notebooks WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!notebook) return res.status(404).json({ error: 'الملاحظة مش موجودة' });
  try {
    var prompt = 'أنت مساعد تعليمي ذكي. الطالب يسألك عن محتوى ملاحظاته التالية:\n\n' +
      '--- بداية الملاحظات ---\n' + notebook.content + '\n--- نهاية الملاحظات ---\n\n' +
      'سؤال الطالب: ' + message.trim() + '\n\n' +
      'أجب بالعربية بشكل واضح ومفيد بناءً على محتوى الملاحظات.';
    var reply = await geminiAsk(prompt);
    res.json({ reply: reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── AI LEARNING PLAN ────────────────────────────────────
app.post('/api/learning-plan', auth, async function(req, res) {
  var goal    = req.body.goal;
  var level   = req.body.level || 'beginner';
  var hours   = req.body.hours_per_day || '2';
  var field   = req.body.field || '';
  if (!goal || !goal.trim()) return res.status(400).json({ error: 'اكتب هدفك' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'الخدمة مش متاحة' });
  try {
    var prompt = 'Create a learning plan in Arabic for someone who wants to: ' + goal + '. ' +
      'Level: ' + level + '. Hours per day: ' + hours + '. ' +
      (field ? 'Field: ' + field + '. ' : '') +
      'Write the plan in Arabic with 3 phases: beginner, intermediate, advanced. Keep it practical and clear.';
    var reply = await geminiAsk(prompt);
    res.json({ plan: reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── LEARNING TIME TRACKER ────────────────────────────────
app.post('/api/learning-log', auth, function(req, res) {
  var seconds = req.body.seconds || 0;
  var date    = new Date().toISOString().split('T')[0];
  var existing = dbGet('SELECT id, seconds FROM learning_log WHERE user_id=? AND date=?', [req.user.id, date]);
  if (existing) {
    dbRun('UPDATE learning_log SET seconds=seconds+? WHERE user_id=? AND date=?', [seconds, req.user.id, date]);
  } else {
    dbRun('INSERT INTO learning_log (user_id,date,seconds) VALUES (?,?,?)', [req.user.id, date, seconds]);
  }
  res.json({ success: true });
});

app.get('/api/learning-log', auth, function(req, res) {
  var logs = dbAll('SELECT * FROM learning_log WHERE user_id=? ORDER BY date DESC LIMIT 30', [req.user.id]);
  // Calculate streak
  var streak = 0;
  var today  = new Date().toISOString().split('T')[0];
  var dates  = logs.map(function(l) { return l.date; });
  var current = new Date(today);
  while (true) {
    var d = current.toISOString().split('T')[0];
    if (dates.indexOf(d) !== -1) { streak++; current.setDate(current.getDate() - 1); }
    else break;
  }
  res.json({ logs: logs, streak: streak });
});

// ─── COMMENTS / COMMUNITY ────────────────────────────────
app.get('/api/comments/:courseId', function(req, res) {
  var comments = dbAll(
    'SELECT c.*, u.name as user_name FROM comments c JOIN users u ON c.user_id=u.id WHERE c.course_id=? ORDER BY c.created_at DESC LIMIT 50',
    [req.params.courseId]
  );
  res.json(comments);
});

app.post('/api/comments', auth, function(req, res) {
  var course_id = req.body.course_id;
  var content   = req.body.content;
  if (!course_id || !content || !content.trim()) return res.status(400).json({ error: 'اكتب تعليقك' });
  var id = dbRun('INSERT INTO comments (user_id,course_id,content) VALUES (?,?,?)',
    [req.user.id, course_id, content.trim()]);
  res.json({ success: true, id: id });
});

app.post('/api/comments/:id/like', auth, function(req, res) {
  var existing = dbGet('SELECT id FROM comment_likes WHERE user_id=? AND comment_id=?', [req.user.id, req.params.id]);
  if (existing) {
    dbRun('DELETE FROM comment_likes WHERE user_id=? AND comment_id=?', [req.user.id, req.params.id]);
    dbRun('UPDATE comments SET likes=likes-1 WHERE id=?', [req.params.id]);
    res.json({ liked: false });
  } else {
    dbRun('INSERT OR IGNORE INTO comment_likes (user_id,comment_id) VALUES (?,?)', [req.user.id, req.params.id]);
    dbRun('UPDATE comments SET likes=likes+1 WHERE id=?', [req.params.id]);
    res.json({ liked: true });
  }
});

app.delete('/api/comments/:id', auth, function(req, res) {
  dbRun('DELETE FROM comments WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// ─── AI PROJECT REVIEW ───────────────────────────────────
app.post('/api/projects/:id/ai-review', auth, async function(req, res) {
  var project = dbGet('SELECT * FROM projects WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!project) return res.status(404).json({ error: 'المشروع مش موجود' });
  if (!GEMINI_KEY) return res.status(503).json({ error: 'الخدمة مش متاحة' });
  try {
    var prompt = 'أنت مقيّم تقني خبير. قيّم المشروع التالي:\n' +
      '- عنوان المشروع: ' + project.title + '\n' +
      '- الوصف: ' + project.description + '\n' +
      '- المجال: ' + project.field + '\n' +
      '- المستوى: ' + project.level + '\n' +
      (project.github_url ? '- رابط GitHub: ' + project.github_url + '\n' : '') +
      '\nاعطِ تقييماً مفصلاً بالعربية يشمل:\n' +
      '1. نقاط القوة في المشروع\n' +
      '2. نقاط الضعف والأخطاء المحتملة\n' +
      '3. اقتراحات للتحسين\n' +
      '4. تقييم من 10\n' +
      '5. الخطوة التالية الموصى بها';
    var reply = await geminiAsk(prompt);
    res.json({ review: reply });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN PAGE ───────────────────────────────────────────
app.get('/admin', function(req, res) {
  res.sendFile(path.join(__dirname, '../pages/admin.html'));
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// ─── START ────────────────────────────────────────────────
initDB().then(function() {
  app.listen(PORT, function() {
    console.log('');
    console.log('=================================');
    console.log('  مَسار شغّال على المنفذ ' + PORT);
    console.log('  http://localhost:' + PORT);
    console.log('=================================');
    console.log('');
  });
});