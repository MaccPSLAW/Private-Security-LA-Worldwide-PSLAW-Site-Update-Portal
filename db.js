const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'portal.db');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON;');
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function callback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function createClientToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function upsertCompanyAdminUser({ name, email, password, companyId }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);
  const existingUser = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);

  if (existingUser) {
    await run(
      `
        UPDATE users
        SET name = ?, password_hash = ?, role = 'company_admin', company_id = ?, active = 1
        WHERE id = ?
      `,
      [name, passwordHash, companyId, existingUser.id]
    );
    return existingUser.id;
  }

  const created = await run(
    `
      INSERT INTO users (name, email, password_hash, role, company_id, active)
      VALUES (?, ?, ?, 'company_admin', ?, 1)
    `,
    [name, normalizedEmail, passwordHash, companyId]
  );

  return created.lastID;
}

async function upsertEmployeeUser({ name, email, password, companyId }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);
  const existingUser = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);

  if (existingUser) {
    await run(
      `
        UPDATE users
        SET name = ?, password_hash = ?, role = 'employee', company_id = ?, active = 1
        WHERE id = ?
      `,
      [name, passwordHash, companyId, existingUser.id]
    );
    return existingUser.id;
  }

  const created = await run(
    `
      INSERT INTO users (name, email, password_hash, role, company_id, active)
      VALUES (?, ?, ?, 'employee', ?, 1)
    `,
    [name, normalizedEmail, passwordHash, companyId]
  );

  return created.lastID;
}

async function migrateUsersRoleConstraintIfNeeded() {
  const usersTable = await get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'"
  );

  if (!usersTable || !usersTable.sql) {
    return;
  }

  if (usersTable.sql.includes("'manager'")) {
    return;
  }

  await run('PRAGMA foreign_keys = OFF');
  await run('BEGIN TRANSACTION');

  try {
    await run(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('company_admin', 'manager', 'employee', 'client')),
        company_id INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
      )
    `);

    await run(`
      INSERT INTO users_new (id, name, email, password_hash, role, company_id, active, created_at)
      SELECT id, name, email, password_hash, role, company_id, active, created_at
      FROM users
    `);

    await run('DROP TABLE users');
    await run('ALTER TABLE users_new RENAME TO users');
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  } finally {
    await run('PRAGMA foreign_keys = ON');
  }
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('company_admin', 'manager', 'employee', 'client')),
      company_id INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `);

  await migrateUsersRoleConstraintIfNeeded();

  await run(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      manager_representative TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
      UNIQUE(company_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS site_user_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      can_post_updates INTEGER NOT NULL DEFAULT 0,
      approved_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(approved_by) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(site_id, user_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS onsite_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      occurrence_time TEXT NOT NULL,
      general_location TEXT NOT NULL,
      client_notified TEXT,
      image_path TEXT,
      attachment_name TEXT,
      attachment_mime TEXT,
      visibility TEXT NOT NULL CHECK(visibility IN ('staff_client', 'staff_only')) DEFAULT 'staff_client',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
    )
  `);

  const hasActiveColumn = await get(
    `SELECT 1 AS has_column FROM pragma_table_info('onsite_updates') WHERE name = 'is_active' LIMIT 1`
  );
  if (!hasActiveColumn) {
    await run('ALTER TABLE onsite_updates ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }

  const hasAttachmentNameColumn = await get(
    `SELECT 1 AS has_column FROM pragma_table_info('onsite_updates') WHERE name = 'attachment_name' LIMIT 1`
  );
  if (!hasAttachmentNameColumn) {
    await run('ALTER TABLE onsite_updates ADD COLUMN attachment_name TEXT');
  }

  const hasAttachmentMimeColumn = await get(
    `SELECT 1 AS has_column FROM pragma_table_info('onsite_updates') WHERE name = 'attachment_mime' LIMIT 1`
  );
  if (!hasAttachmentMimeColumn) {
    await run('ALTER TABLE onsite_updates ADD COLUMN attachment_mime TEXT');
  }

  await run(`
    CREATE TABLE IF NOT EXISTS site_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_review', 'resolved')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS client_portal_links (
      user_id INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      site_id INTEGER,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE SET NULL,
      FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stream_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      site_id INTEGER NOT NULL,
      onsite_update_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      parent_message_id INTEGER,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
      FOREIGN KEY(onsite_update_id) REFERENCES onsite_updates(id) ON DELETE CASCADE,
      FOREIGN KEY(author_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(parent_message_id) REFERENCES stream_messages(id) ON DELETE CASCADE
    )
  `);

  const existingCompany = await get('SELECT id FROM companies WHERE name = ?', ['PSLAW Security']);
  let companyId = existingCompany ? existingCompany.id : null;

  if (!existingCompany) {
    const companyResult = await run('INSERT INTO companies (name) VALUES (?)', ['PSLAW Security']);
    companyId = companyResult.lastID;

    const adminPasswordHash = await bcrypt.hash('Admin123!', 10);
    const adminResult = await run(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES (?, ?, ?, 'company_admin', ?)`,
      ['Company Admin', 'admin@pslaw.local', adminPasswordHash, companyId]
    );

    const adminId = adminResult.lastID;

    const siteResult = await run(
      `INSERT INTO sites (company_id, name, address, manager_representative, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [companyId, 'Downtown Tower', '100 Main St, Los Angeles, CA', 'Jordan Blake', adminId]
    );

    await run(
      `INSERT INTO site_user_access (site_id, user_id, can_post_updates, approved_by)
       VALUES (?, ?, 1, ?)`,
      [siteResult.lastID, adminId, adminId]
    );

    const employeePasswordHash = await bcrypt.hash('Employee123!', 10);
    const employeeResult = await run(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES (?, ?, ?, 'employee', ?)`,
      ['Field Employee', 'employee@pslaw.local', employeePasswordHash, companyId]
    );

    await run(
      `INSERT INTO site_user_access (site_id, user_id, can_post_updates, approved_by)
       VALUES (?, ?, 1, ?)`,
      [siteResult.lastID, employeeResult.lastID, adminId]
    );

    const clientPasswordHash = await bcrypt.hash('Client123!', 10);
    const clientResult = await run(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES (?, ?, ?, 'client', ?)`,
      ['Client Viewer', 'client@pslaw.local', clientPasswordHash, companyId]
    );

    await run(
      `INSERT INTO site_user_access (site_id, user_id, can_post_updates, approved_by)
       VALUES (?, ?, 0, ?)`,
      [siteResult.lastID, clientResult.lastID, adminId]
    );

    await run(
      `INSERT INTO client_portal_links (user_id, token)
       VALUES (?, ?)`,
      [clientResult.lastID, createClientToken()]
    );
  }

  await upsertCompanyAdminUser({
    name: 'PSLAW COO',
    email: 'coo.pslaworldwide@gmail.com',
    password: 'PSLA1!',
    companyId,
  });

  await upsertCompanyAdminUser({
    name: 'PSLAW Worldwide Admin',
    email: 'pslawworldwide@gmail.com',
    password: 'PSLA11!',
    companyId,
  });

  const demoEmployeeId = await upsertEmployeeUser({
    name: 'Demo Employee',
    email: 'maccess@demo.com',
    password: 'demo1!',
    companyId,
  });

  const demoSite = await get('SELECT id FROM sites WHERE company_id = ? ORDER BY id LIMIT 1', [companyId]);
  const approver = await get(
    `
      SELECT id
      FROM users
      WHERE company_id = ? AND role = 'company_admin'
      ORDER BY id
      LIMIT 1
    `,
    [companyId]
  );

  if (demoSite) {
    await run(
      `
        INSERT INTO site_user_access (site_id, user_id, can_post_updates, approved_by)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(site_id, user_id)
        DO UPDATE SET can_post_updates = 1, approved_by = excluded.approved_by
      `,
      [demoSite.id, demoEmployeeId, approver ? approver.id : null]
    );
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
  createClientToken,
};
