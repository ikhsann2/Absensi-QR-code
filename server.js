require('dotenv').config(); // Load environment variables dari .env
const express = require('express');
const cors = require('cors');
const ExcelJS = require('exceljs');

// Import Modul Lokal
const pool = require('./src/db');
const { generateSecureQRPayload, verifyQRPayload } = require('./src/qrSecurity');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const WORK_START_TIME = '08:00'; // Jam masuk standar

// API 1: Generate Secure Dynamic QR Code Payload
app.get('/api/qr/generate', (req, res) => {
  const qrPayload = generateSecureQRPayload();
  res.json({ qrPayload });
});

// API 2: Scan Absen (Masuk / Pulang) dengan Validasi Keamanan HMAC
app.post('/api/attendance/scan', async (req, res) => {
  const { userId, qrToken, timestamp, isOfflineSync } = req.body;

  // Verifikasi QR Code dengan menyertakan userId karyawan
  if (!isOfflineSync) {
    const qrValidation = verifyQRPayload(qrToken, userId); // <-- Tambahkan userId di sini
    if (!qrValidation.valid) {
      return res.status(400).json({ success: false, message: qrValidation.message });
    }
  }

  try {
    // 2. Cek apakah user/karyawan terdaftar
    const userQuery = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Karyawan tidak ditemukan.' });
    }

    const scanTime = new Date(timestamp);
    const dateStr = scanTime.toISOString().split('T')[0];
    const timeStr = scanTime.toTimeString().split(' ')[0].substring(0, 5);

    // 3. Cek riwayat absen hari ini
    const logQuery = await pool.query(
      'SELECT * FROM attendance_logs WHERE user_id = $1 AND attendance_date = $2',
      [userId, dateStr]
    );

    if (logQuery.rows.length === 0) {
      // --- ABSEN MASUK ---
      const [targetHour, targetMinute] = WORK_START_TIME.split(':').map(Number);
      const isLate = scanTime.getHours() > targetHour || 
                    (scanTime.getHours() === targetHour && scanTime.getMinutes() > targetMinute);

      const insertQuery = `
        INSERT INTO attendance_logs (user_id, attendance_date, check_in, is_late)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `;
      const insertedLog = await pool.query(insertQuery, [userId, dateStr, timeStr, isLate]);

      return res.json({
        success: true,
        message: `Absen Masuk Berhasil (${isLate ? 'YA - Terlambat' : 'Tepat Waktu'})`,
        data: insertedLog.rows[0]
      });

    } else {
      const existingLog = logQuery.rows[0];

      if (!existingLog.check_out) {
        // --- ABSEN PULANG ---
        const [inH, inM] = existingLog.check_in.split(':').map(Number);
        const [outH, outM] = timeStr.split(':').map(Number);
        const duration = parseFloat((((outH * 60 + outM) - (inH * 60 + inM)) / 60).toFixed(2));

        const updateQuery = `
          UPDATE attendance_logs
          SET check_out = $1, work_hours = $2
          WHERE id = $3
          RETURNING *;
        `;
        const updatedLog = await pool.query(updateQuery, [timeStr, duration, existingLog.id]);

        return res.json({
          success: true,
          message: 'Absen Pulang Berhasil',
          data: updatedLog.rows[0]
        });

      } else {
        return res.status(400).json({ success: false, message: 'Anda sudah menyelesaikan absen hari ini.' });
      }
    }

  } catch (err) {
    console.error('Database Error:', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server database.' });
  }
});

// API 3: Ambil Data Rekap untuk Admin
app.get('/api/admin/logs', async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id AS "userId",
        u.name,
        u.position,
        TO_CHAR(a.attendance_date, 'YYYY-MM-DD') AS date,
        a.check_in AS "checkIn",
        a.check_out AS "checkOut",
        a.work_hours AS "workHours",
        CASE WHEN a.is_late THEN 'YA (Terlambat)' ELSE 'Tepat Waktu' END AS "isLate"
      FROM attendance_logs a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.attendance_date DESC, a.check_in DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal mengambil log absensi.' });
  }
});

// API 4: Export Data ke Excel
app.get('/api/admin/export-excel', async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id AS "userId",
        u.name,
        u.position,
        TO_CHAR(a.attendance_date, 'YYYY-MM-DD') AS date,
        a.check_in AS "checkIn",
        a.check_out AS "checkOut",
        a.work_hours AS "workHours",
        CASE WHEN a.is_late THEN 'YA (Terlambat)' ELSE 'Tepat Waktu' END AS "isLate"
      FROM attendance_logs a
      JOIN users u ON a.user_id = u.id
      ORDER BY a.attendance_date ASC;
    `;
    const result = await pool.query(query);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rekap Absensi');

    worksheet.columns = [
      { header: 'ID Karyawan', key: 'userId', width: 15 },
      { header: 'Nama Karyawan', key: 'name', width: 25 },
      { header: 'Posisi / Jabatan', key: 'position', width: 20 },
      { header: 'Tanggal', key: 'date', width: 15 },
      { header: 'Waktu Masuk', key: 'checkIn', width: 15 },
      { header: 'Waktu Pulang', key: 'checkOut', width: 15 },
      { header: 'Status Keterlambatan', key: 'isLate', width: 20 },
      { header: 'Total Jam Kerja', key: 'workHours', width: 18 }
    ];

    worksheet.getRow(1).font = { bold: true };
    result.rows.forEach(log => worksheet.addRow(log));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Rekap_Absensi.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).send('Gagal membuat file Excel.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server aman berjalan pada port ${PORT}`));