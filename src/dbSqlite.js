const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function initDB() {
  const db = await open({
    filename: path.join(__dirname, '../absensi.db'), // Atau './database.sqlite' sesuai lokasi di server.js
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position TEXT NOT NULL,
      email TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'user',
      face_image TEXT,
      face_descriptor TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      attendance_date TEXT,
      check_in TEXT,
      check_out TEXT,
      status TEXT DEFAULT 'Hadir',
      doc_image TEXT,
      work_hours REAL DEFAULT 0,
      is_late INTEGER DEFAULT 0,
      UNIQUE(user_id, attendance_date)
    );
  `);

  // PROTEKSI AUTO-MIGRATION: Tambahkan kolom baru jika belum ada di database lama
  try { await db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';`); } catch (e) {}
  try { await db.exec(`ALTER TABLE users ADD COLUMN face_image TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE users ADD COLUMN face_descriptor TEXT;`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN status TEXT DEFAULT 'Hadir';`); } catch (e) {}
  try { await db.exec(`ALTER TABLE attendance_logs ADD COLUMN doc_image TEXT;`); } catch (e) {}

  console.log('✅ Database SQLite terhubung & Kolom Role/Dokumen Siap.');
  return db;
}

module.exports = initDB;