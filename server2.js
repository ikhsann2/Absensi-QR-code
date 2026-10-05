require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const WORK_START_TIME = process.env.WORK_START_TIME || "07:30";

const DEFAULT_TARGET_OUT = {
  TK: "14:30",
  SD: "15:20",
  SMP: "16:50"
};

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `doc_${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
(async () => {
  db = await open({
    filename: './database.sqlite',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      position TEXT,
      level TEXT DEFAULT 'SD',
      email TEXT,
      password TEXT,
      role TEXT DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      attendance_date TEXT,
      check_in TEXT,
      check_out TEXT,
      status TEXT DEFAULT 'Hadir',
      doc_image TEXT,
      reason TEXT,
      work_hours REAL DEFAULT 0,
      is_late INTEGER DEFAULT 0,
      is_overtime INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS overtime_settings (
      level TEXT PRIMARY KEY,
      target_out TEXT,
      max_overtime_out TEXT,
      is_overtime_active INTEGER DEFAULT 0
    );
  `);

  try { await db.exec(`ALTER TABLE users ADD COLUMN level TEXT DEFAULT 'SD';`); } catch (e) {}
  try { await db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN status TEXT DEFAULT 'Hadir';`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN doc_image TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN reason TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN work_hours REAL DEFAULT 0;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN is_overtime INTEGER DEFAULT 0;`); } catch (e) {}

  const tkSetting = await db.get(`SELECT * FROM overtime_settings WHERE level = 'TK'`);
  if (!tkSetting) {
    await db.run(`INSERT INTO overtime_settings (level, target_out, max_overtime_out, is_overtime_active) VALUES ('TK', '14:30', '17:00', 0)`);
    await db.run(`INSERT INTO overtime_settings (level, target_out, max_overtime_out, is_overtime_active) VALUES ('SD', '15:20', '17:30', 0)`);
    await db.run(`INSERT INTO overtime_settings (level, target_out, max_overtime_out, is_overtime_active) VALUES ('SMP', '16:50', '18:30', 0)`);
  }

  const admin = await db.get(`SELECT * FROM users WHERE id = 'ADMIN-01'`);
  if (!admin) {
    await db.run(`INSERT INTO users (id, name, position, level, email, password, role) VALUES ('ADMIN-01', 'Administrator', 'HRD Admin', 'Semua', 'admin', '123', 'admin')`);
  }

  console.log('✅ Database SQLite Terhubung & Tabel Siap.');
})();

// API Authentication
app.post('/api/auth/register', async (req, res) => {
  const { name, position, level, email, password } = req.body;
  if (!name || !position || !email || !password) {
    return res.status(400).json({ success: false, message: 'Semua kolom wajib diisi!' });
  }

  try {
    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email sudah terdaftar.' });
    }

    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const userId = `COR-${randomNum}`;
    const userLevel = level || 'SD';

    await db.run(
      `INSERT INTO users (id, name, position, level, email, password, role) VALUES (?, ?, ?, ?, ?, ?, 'user')`,
      [userId, name, position, userLevel, email, password]
    );

    res.json({
      success: true,
      message: 'Pendaftaran berhasil!',
      userData: { id: userId, name, position, level: userLevel, email, role: 'user' }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal mendaftar: ' + err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db.get('SELECT * FROM users WHERE (email = ? OR id = ?) AND password = ?', [email, email, password]);
    if (!user) {
      return res.status(400).json({ success: false, message: 'Username/Email atau Password salah!' });
    }
    res.json({
      success: true,
      role: user.role,
      userData: { id: user.id, name: user.name, position: user.position, level: user.level || 'SD', email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal login.' });
  }
});

app.get('/api/user/today-status', async (req, res) => {
  const { userId } = req.query;
  const today = new Date().toISOString().split('T')[0];
  try {
    const log = await db.get(`SELECT * FROM attendance_logs WHERE user_id = ? AND attendance_date = ?`, [userId, today]);
    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/qr/generate', '/api/qr/current'], (req, res) => {
  const qrPayload = `CORDOVA-QR-${Math.floor(Date.now() / 10000)}`;
  res.json({ success: true, qrPayload, qrToken: qrPayload, timestamp: Date.now() });
});

// API Scan QR Absensi
app.post('/api/attendance/scan', async (req, res) => {
  const { userId, timestamp } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'ID Guru tidak terdeteksi.' });

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ success: false, message: 'ID Guru tidak ditemukan.' });

    const userLevel = (user.level || 'SD').toUpperCase();
    const scanTime = new Date(timestamp || Date.now());
    const dateStr = scanTime.toISOString().split('T')[0];
    const realTimeStr = scanTime.toTimeString().split(' ')[0].substring(0, 5);

    const existingLog = await db.get(
      'SELECT * FROM attendance_logs WHERE user_id = ? AND attendance_date = ?',
      [userId, dateStr]
    );

    if (!existingLog) {
      const [targetHour, targetMinute] = WORK_START_TIME.split(':').map(Number);
      const isLate = scanTime.getHours() > targetHour || 
                    (scanTime.getHours() === targetHour && scanTime.getMinutes() > targetMinute);

      await db.run(
        `INSERT INTO attendance_logs (user_id, attendance_date, check_in, is_late, status, work_hours)
         VALUES (?, ?, ?, ?, 'Hadir', 0)`,
        [userId, dateStr, realTimeStr, isLate ? 1 : 0]
      );

      return res.json({ success: true, message: `Absen Masuk Berhasil (${isLate ? 'Terlambat' : 'Tepat Waktu'})` });
    } else {
      if (!existingLog.check_out || existingLog.check_out === '-') {
        const setting = await db.get(`SELECT * FROM overtime_settings WHERE level = ?`, [userLevel]);
        const targetOutStr = setting ? setting.target_out : (DEFAULT_TARGET_OUT[userLevel] || "15:20");
        const maxOvertimeStr = setting ? setting.max_overtime_out : "17:30";

        const isOvertimeAllowed = (existingLog.is_overtime === 1) || (setting && setting.is_overtime_active === 1);

        const [inH, inM] = existingLog.check_in.split(':').map(Number);
        const [realOutH, realOutM] = realTimeStr.split(':').map(Number);
        const [targetOutH, targetOutM] = targetOutStr.split(':').map(Number);
        const [maxOverH, maxOverM] = maxOvertimeStr.split(':').map(Number);

        const realOutMinutes = realOutH * 60 + realOutM;
        const targetOutMinutes = targetOutH * 60 + targetOutM;
        const maxOverMinutes = maxOverH * 60 + maxOverM;

        let finalRecordedOutStr = realTimeStr;
        let finalOutMinutes = realOutMinutes;

        if (!isOvertimeAllowed) {
          if (realOutMinutes > targetOutMinutes) {
            finalRecordedOutStr = targetOutStr;
            finalOutMinutes = targetOutMinutes;
          }
        } else {
          if (realOutMinutes > maxOverMinutes) {
            finalRecordedOutStr = maxOvertimeStr;
            finalOutMinutes = maxOverMinutes;
          }
        }

        const inMinutes = inH * 60 + inM;
        let duration = parseFloat(((finalOutMinutes - inMinutes) / 60).toFixed(2));
        if (duration < 0) duration = 0;

        await db.run(
          `UPDATE attendance_logs SET check_out = ?, work_hours = ? WHERE id = ?`,
          [finalRecordedOutStr, duration, existingLog.id]
        );

        return res.json({ success: true, message: `Absen Pulang Berhasil (${finalRecordedOutStr}${isOvertimeAllowed ? ' - Lembur' : ''})` });
      } else {
        return res.status(400).json({ success: false, message: 'Anda sudah menyelesaikan absensi hari ini.' });
      }
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal mencatat absensi: ' + err.message });
  }
});

// User Submit Lembur, Izin & Sakit
app.post('/api/user/lembur', upload.single('docImage'), async (req, res) => {
  const { userId, date, reason } = req.body;
  const docImage = req.file ? `/uploads/${req.file.filename}` : req.body.docBase64;
  const today = date || new Date().toISOString().split('T')[0];

  try {
    const existing = await db.get(`SELECT * FROM attendance_logs WHERE user_id = ? AND attendance_date = ?`, [userId, today]);
    if (existing) {
      await db.run(
        `UPDATE attendance_logs SET is_overtime = 1, doc_image = ?, reason = ? WHERE id = ?`,
        [docImage, `[LEMBUR] ${reason}`, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO attendance_logs (user_id, attendance_date, status, is_overtime, doc_image, reason, check_in, check_out, work_hours) 
         VALUES (?, ?, 'Hadir', 1, ?, ?, '07:30', '-', 0)`,
        [userId, today, docImage, `[LEMBUR] ${reason}`]
      );
    }
    res.json({ success: true, message: 'Pengajuan Lembur Berhasil Dikirim!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/izin', upload.single('docImage'), async (req, res) => {
  const { userId, date, reason } = req.body;
  const docImage = req.file ? `/uploads/${req.file.filename}` : req.body.docBase64;
  const today = date || new Date().toISOString().split('T')[0];

  try {
    const existing = await db.get(`SELECT * FROM attendance_logs WHERE user_id = ? AND attendance_date = ?`, [userId, today]);
    if (existing) {
      await db.run(`UPDATE attendance_logs SET status = 'Izin', doc_image = ?, reason = ? WHERE id = ?`, [docImage, reason || 'Izin', existing.id]);
    } else {
      await db.run(
        `INSERT INTO attendance_logs (user_id, attendance_date, status, doc_image, reason, check_in, check_out, work_hours) 
         VALUES (?, ?, 'Izin', ?, ?, '-', '-', 0)`,
        [userId, today, docImage, reason || 'Izin']
      );
    }
    res.json({ success: true, message: 'Surat Izin Berhasil Dikirim.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/user/sakit', upload.single('docImage'), async (req, res) => {
  const { userId, date } = req.body;
  const docImage = req.file ? `/uploads/${req.file.filename}` : req.body.docBase64;
  const today = date || new Date().toISOString().split('T')[0];

  try {
    const existing = await db.get(`SELECT * FROM attendance_logs WHERE user_id = ? AND attendance_date = ?`, [userId, today]);
    if (existing) {
      await db.run(`UPDATE attendance_logs SET status = 'Sakit', doc_image = ? WHERE id = ?`, [docImage, existing.id]);
    } else {
      await db.run(
        `INSERT INTO attendance_logs (user_id, attendance_date, status, doc_image, check_in, check_out, work_hours) 
         VALUES (?, ?, 'Sakit', ?, '-', '-', 0)`,
        [userId, today, docImage]
      );
    }
    res.json({ success: true, message: 'Surat Sakit Berhasil Dikirim.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin Stats & Logs
app.get('/api/admin/stats', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const totalUsers = await db.get(`SELECT COUNT(*) as count FROM users WHERE role = 'user'`);
    const hadir = await db.get(`SELECT COUNT(*) as count FROM attendance_logs WHERE attendance_date = ? AND status = 'Hadir'`, [today]);
    const sakit = await db.get(`SELECT COUNT(*) as count FROM attendance_logs WHERE attendance_date = ? AND status = 'Sakit'`, [today]);
    const izin = await db.get(`SELECT COUNT(*) as count FROM attendance_logs WHERE attendance_date = ? AND status = 'Izin'`, [today]);
    const lembur = await db.get(`SELECT COUNT(*) as count FROM attendance_logs WHERE attendance_date = ? AND is_overtime = 1`, [today]);

    const tkCount = await db.get(`SELECT COUNT(*) as count FROM users WHERE role = 'user' AND level = 'TK'`);
    const sdCount = await db.get(`SELECT COUNT(*) as count FROM users WHERE role = 'user' AND level = 'SD'`);
    const smpCount = await db.get(`SELECT COUNT(*) as count FROM users WHERE role = 'user' AND level = 'SMP'`);

    res.json({
      totalEmployees: totalUsers.count || 0,
      hadirToday: hadir.count || 0,
      sakitToday: sakit.count || 0,
      izinToday: izin.count || 0,
      lemburToday: lembur.count || 0,
      levelStats: { tk: tkCount.count || 0, sd: sdCount.count || 0, smp: smpCount.count || 0 }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/admin/logs', '/api/admin/attendance-logs'], async (req, res) => {
  const { date, month, level, search, userId } = req.query;
  const today = new Date().toISOString().split('T')[0];

  let query = `
    SELECT 
      a.id, 
      u.id AS userId, 
      u.name, 
      u.position, 
      u.level,
      a.attendance_date AS date, 
      a.check_in AS checkIn, 
      a.check_out AS checkOut, 
      a.work_hours AS workHours,
      CASE WHEN a.is_late = 1 THEN 'YA (Terlambat)' ELSE 'Tepat Waktu' END AS isLate,
      a.status, 
      a.doc_image AS docImage,
      a.reason,
      a.is_overtime AS isOvertime
    FROM attendance_logs a
    JOIN users u ON a.user_id = u.id
    WHERE 1=1
  `;
  let params = [];

  // Default: Hanya ambil hari ini jika tidak ada filter pencarian/bulan
  if (!date && !month && !level && !search && !userId) {
    query += ` AND a.attendance_date = ?`;
    params.push(today);
  } else {
    if (date) { query += ` AND a.attendance_date = ?`; params.push(date); }
    if (month) { query += ` AND a.attendance_date LIKE ?`; params.push(`${month}%`); }
    if (level) { query += ` AND u.level = ?`; params.push(level); }
    if (userId) { query += ` AND u.id = ?`; params.push(userId); }
    if (search) {
      query += ` AND (u.name LIKE ? OR u.id LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
  }

  query += ` ORDER BY a.attendance_date DESC, a.id DESC`;

  try {
    const logs = await db.all(query, params);
    let totalWorkHours = 0, totalHadir = 0, totalSakit = 0, totalIzin = 0, totalLembur = 0;

    logs.forEach(l => {
      totalWorkHours += (l.workHours || 0);
      if (l.status === 'Hadir') totalHadir++;
      else if (l.status === 'Sakit') totalSakit++;
      else if (l.status === 'Izin') totalIzin++;
      if (l.isOvertime === 1) totalLembur++;
    });

    res.json({
      logs: logs,
      summary: {
        totalWorkHours: parseFloat(totalWorkHours.toFixed(2)),
        totalHadir,
        totalSakit,
        totalIzin,
        totalLembur,
        totalRecords: logs.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/logs/:id', async (req, res) => {
  const { id } = req.params;
  const { status, checkIn, checkOut, reason } = req.body;

  try {
    let duration = 0;
    if (checkIn && checkOut && checkOut !== '-') {
      const [inH, inM] = checkIn.split(':').map(Number);
      const [outH, outM] = checkOut.split(':').map(Number);
      duration = parseFloat((((outH * 60 + outM) - (inH * 60 + inM)) / 60).toFixed(2));
    }

    await db.run(
      `UPDATE attendance_logs 
       SET status = ?, check_in = ?, check_out = ?, reason = ?, work_hours = ? 
       WHERE id = ?`,
      [status, checkIn || '07:30', checkOut || '15:20', reason || '', duration > 0 ? duration : 0, id]
    );

    res.json({ success: true, message: 'Status absensi berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/logs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run(`DELETE FROM attendance_logs WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Data berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/overtime-settings', async (req, res) => {
  try {
    const settings = await db.all(`SELECT * FROM overtime_settings ORDER BY level ASC`);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/overtime-settings', async (req, res) => {
  const { level, target_out, max_overtime_out, is_overtime_active } = req.body;
  try {
    await db.run(
      `UPDATE overtime_settings 
       SET target_out = ?, max_overtime_out = ?, is_overtime_active = ? 
       WHERE level = ?`,
      [target_out, max_overtime_out, is_overtime_active ? 1 : 0, level]
    );
    res.json({ success: true, message: `Setting jam pulang & lembur jenjang ${level} disimpan.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await db.all(`SELECT id, name, position, level, email, role FROM users WHERE role = 'user' ORDER BY level ASC, name ASC`);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run(`DELETE FROM attendance_logs WHERE user_id = ?`, [id]);
    await db.run(`DELETE FROM users WHERE id = ?`, [id]);
    res.json({ success: true, message: 'Akun guru dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/export-excel', async (req, res) => {
  const { date, month, level, search, userId } = req.query;
  const today = new Date().toISOString().split('T')[0];

  let query = `
    SELECT 
      u.id AS userId, 
      u.name, 
      u.position, 
      u.level,
      a.attendance_date AS date, 
      a.check_in AS checkIn, 
      a.check_out AS checkOut, 
      a.work_hours AS workHours,
      CASE WHEN a.is_late = 1 THEN 'YA (Terlambat)' ELSE 'Tepat Waktu' END AS isLate,
      a.status,
      a.reason,
      a.is_overtime AS isOvertime
    FROM attendance_logs a
    JOIN users u ON a.user_id = u.id
    WHERE 1=1
  `;
  let params = [];

  if (!date && !month && !level && !search && !userId) {
    query += ` AND a.attendance_date = ?`;
    params.push(today);
  } else {
    if (date) { query += ` AND a.attendance_date = ?`; params.push(date); }
    if (month) { query += ` AND a.attendance_date LIKE ?`; params.push(`${month}%`); }
    if (level) { query += ` AND u.level = ?`; params.push(level); }
    if (userId) { query += ` AND u.id = ?`; params.push(userId); }
    if (search) {
      query += ` AND (u.name LIKE ? OR u.id LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
  }

  query += ` ORDER BY u.level ASC, u.name ASC, a.attendance_date ASC`;

  try {
    const logs = await db.all(query, params);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rekapitulasi Presensi', { views: [{ showGridLines: true }] });

    worksheet.mergeCells('A1:J1');
    const mainTitle = worksheet.getCell('A1');
    mainTitle.value = 'LEMBAR REKAPITULASI PRESENSI & AKUMULASI JAM KERJA';
    mainTitle.font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
    mainTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    mainTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    worksheet.getRow(1).height = 30;

    let totalJamKerja = 0, totalHadir = 0, totalSakit = 0, totalIzin = 0;
    logs.forEach(l => {
      totalJamKerja += (l.workHours || 0);
      if (l.status === 'Hadir') totalHadir++;
      else if (l.status === 'Sakit') totalSakit++;
      else if (l.status === 'Izin') totalIzin++;
    });

    const singleUser = (logs.length > 0 && (search || userId)) ? logs[0] : null;

    worksheet.getCell('A4').value = 'Nama Karyawan / Guru:';
    worksheet.getCell('B4').value = singleUser ? singleUser.name : (search ? search : 'Semua Karyawan');
    worksheet.getCell('A5').value = 'ID Guru / NIP:';
    worksheet.getCell('B5').value = singleUser ? singleUser.userId : '-';

    worksheet.getCell('D4').value = 'Periode Bulan:';
    worksheet.getCell('E4').value = month ? `${month}` : (date ? `Tanggal ${date}` : `Hari Ini (${today})`);
    worksheet.getCell('D5').value = 'Jenjang & Jabatan:';
    worksheet.getCell('E5').value = singleUser ? `${singleUser.level} - ${singleUser.position}` : (level ? level : 'Semua Jenjang');

    ['A4','A5','D4','D5'].forEach(p => worksheet.getCell(p).font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FF475569' } });

    worksheet.mergeCells('G4:H4');
    worksheet.getCell('G4').value = 'TOTAL KEHADIRAN';
    worksheet.getCell('G4').font = { name: 'Arial', size: 8, bold: true, color: { argb: 'FF059669' } };
    worksheet.getCell('G4').alignment = { horizontal: 'center' };

    worksheet.mergeCells('G5:H5');
    worksheet.getCell('G5').value = `${totalHadir} Hari`;
    worksheet.getCell('G5').font = { name: 'Arial', size: 13, bold: true, color: { argb: 'FF059669' } };
    worksheet.getCell('G5').alignment = { horizontal: 'center' };

    worksheet.mergeCells('I4:J4');
    worksheet.getCell('I4').value = 'TOTAL JAM KERJA';
    worksheet.getCell('I4').font = { name: 'Arial', size: 8, bold: true, color: { argb: 'FF1E40AF' } };
    worksheet.getCell('I4').alignment = { horizontal: 'center' };

    worksheet.mergeCells('I5:J5');
    worksheet.getCell('I5').value = `${totalJamKerja.toFixed(2)} Jam`;
    worksheet.getCell('I5').font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF1E40AF' } };
    worksheet.getCell('I5').alignment = { horizontal: 'center' };

    ['G4', 'G5', 'I4', 'I5'].forEach(cellPos => {
      worksheet.getCell(cellPos).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });

    const startRow = 7;
    const headerRow = worksheet.getRow(startRow);
    headerRow.values = ['No', 'ID Guru', 'Nama Lengkap', 'Jenjang', 'Tanggal', 'Masuk', 'Pulang', 'Jam Kerja (Jam)', 'Status', 'Alasan / Keterangan'];
    headerRow.height = 24;

    headerRow.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    let currentRow = startRow + 1;
    logs.forEach((log, index) => {
      const row = worksheet.getRow(currentRow);
      row.values = [
        index + 1,
        log.userId,
        log.name,
        log.level || 'SD',
        log.date,
        log.checkIn || '-',
        log.checkOut || '-',
        Number(log.workHours || 0),
        log.status + (log.isOvertime ? ' (Lembur)' : ''),
        log.reason || '-'
      ];
      currentRow++;
    });

    const cleanSearchName = search ? search.replace(/[^a-zA-Z0-9]/g, '_') : 'Semua';
    const fileName = `Rekap_Presensi_${month || date || 'Hari_Ini'}_${cleanSearchName}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).send('Gagal Export Excel: ' + err.message);
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));