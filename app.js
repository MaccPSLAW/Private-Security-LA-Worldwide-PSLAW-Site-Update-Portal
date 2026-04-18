const fsPromises = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');

const { all, get, run, initDb, createClientToken } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const DEMO_EMPLOYEE_EMAIL = 'maccess@demo.com';

function withBasePath(urlPath) {
  const normalized = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  if (!BASE_PATH) {
    return normalized;
  }
  if (normalized === BASE_PATH || normalized.startsWith(`${BASE_PATH}/`)) {
    return normalized;
  }
  return `${BASE_PATH}${normalized}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimePrefixes = ['image/', 'video/', 'audio/', 'text/'];
    const allowedExactMimes = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
      'application/json',
    ]);

    const accepted = allowedMimePrefixes.some((prefix) => file.mimetype.startsWith(prefix))
      || allowedExactMimes.has(file.mimetype);

    if (!accepted) {
      cb(new Error('Unsupported attachment type. Please upload image, document, text, zip, audio, or video files.'));
      return;
    }
    cb(null, true);
  },
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

if (BASE_PATH) {
  app.use((req, res, next) => {
    if (req.url === BASE_PATH || req.url === `${BASE_PATH}/`) {
      req.url = '/';
      next();
      return;
    }

    if (req.url.startsWith(`${BASE_PATH}/`)) {
      req.url = req.url.slice(BASE_PATH.length) || '/';
    }

    next();
  });
}

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
    secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (location, ...args) => {
    if (typeof location === 'string' && location.startsWith('/')) {
      return originalRedirect(withBasePath(location), ...args);
    }
    return originalRedirect(location, ...args);
  };

  res.locals.currentUser = req.session.user || null;
  res.locals.dayjs = dayjs;
  res.locals.error = req.session.error || null;
  res.locals.success = req.session.success || null;
  res.locals.basePath = BASE_PATH;
  res.locals.withBase = withBasePath;
  res.locals.currentPath = req.path;
  delete req.session.error;
  delete req.session.success;
  next();
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.error = 'Please sign in first.';
    res.redirect('/login');
    return;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      req.session.error = 'You are not authorized for that page.';
      res.redirect('/');
      return;
    }
    next();
  };
}

function dashboardRouteForRole(role) {
  if (role === 'company_admin' || role === 'manager') return '/admin';
  if (role === 'employee') return '/employee';
  return '/client';
}

function csvEscape(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  const text = String(value);
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function toCsv(rows, columns) {
  const header = columns.map((column) => csvEscape(column.header)).join(',');
  const body = rows
    .map((row) => columns.map((column) => csvEscape(row[column.key])).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

function sendCsv(res, fileName, rows, columns) {
  const csv = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(csv);
}

async function logAudit({ companyId, actorUserId, action, entityType, entityId = null, details = null }) {
  await run(
    `
      INSERT INTO audit_logs (company_id, actor_user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [companyId, actorUserId, action, entityType, entityId, details ? JSON.stringify(details) : null]
  );
}

async function removeUploadedFile(imagePath) {
  if (!imagePath) {
    return;
  }

  const fileName = path.basename(imagePath);
  const absolutePath = path.join(__dirname, 'uploads', fileName);

  try {
    await fsPromises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function loadApprovedSitesForUser(userId, companyId) {
  return all(
    `
      SELECT s.id, s.name, s.address, s.manager_representative, sua.can_post_updates
      FROM site_user_access sua
      JOIN sites s ON s.id = sua.site_id
      WHERE sua.user_id = ? AND s.company_id = ?
      ORDER BY s.name
    `,
    [userId, companyId]
  );
}

async function loadCompanyAdmins(companyId) {
  return all(
    `
      SELECT id, name, email
      FROM users
      WHERE company_id = ? AND role IN ('company_admin', 'manager') AND active = 1
      ORDER BY name
    `,
    [companyId]
  );
}

function isStaffRole(role) {
  return ['company_admin', 'manager', 'employee'].includes(role);
}

async function loadAccessibleSiteIdsForUser(user) {
  if (user.role === 'company_admin' || user.role === 'manager') {
    const sites = await all('SELECT id FROM sites WHERE company_id = ?', [user.companyId]);
    return sites.map((site) => site.id);
  }

  const approved = await loadApprovedSitesForUser(user.id, user.companyId);
  return approved.map((site) => site.id);
}

function buildMessageMaps(messages) {
  const questionsByUpdate = {};
  const repliesByQuestion = {};

  messages.forEach((message) => {
    if (!message.parent_message_id) {
      if (!questionsByUpdate[message.onsite_update_id]) {
        questionsByUpdate[message.onsite_update_id] = [];
      }
      questionsByUpdate[message.onsite_update_id].push(message);
      return;
    }

    if (!repliesByQuestion[message.parent_message_id]) {
      repliesByQuestion[message.parent_message_id] = [];
    }
    repliesByQuestion[message.parent_message_id].push(message);
  });

  return { questionsByUpdate, repliesByQuestion };
}

async function loadStreamDataForUser(user) {
  const siteIds = await loadAccessibleSiteIdsForUser(user);
  if (!siteIds.length) {
    return {
      updates: [],
      questionsByUpdate: {},
      repliesByQuestion: {},
    };
  }

  const sitePlaceholders = siteIds.map(() => '?').join(', ');

  const params = [...siteIds];
  let visibilitySql = 'AND ou.is_active = 1';
  if (user.role === 'client') {
    visibilitySql = "AND ou.is_active = 1 AND ou.visibility = 'staff_client'";
  }

  const updates = await all(
    `
      SELECT ou.id, ou.site_id, ou.title, ou.details, ou.occurrence_date, ou.occurrence_time,
             ou.general_location, ou.client_notified, ou.image_path, ou.attachment_name,
             ou.attachment_mime, ou.visibility, ou.created_at,
             s.name AS site_name, u.name AS author_name
      FROM onsite_updates ou
      JOIN sites s ON s.id = ou.site_id
      JOIN users u ON u.id = ou.created_by
      WHERE ou.site_id IN (${sitePlaceholders})
      ${visibilitySql}
      ORDER BY ou.created_at DESC
      LIMIT 100
    `,
    params
  );

  const updateIds = updates.map((update) => update.id);
  if (!updateIds.length) {
    return {
      updates,
      questionsByUpdate: {},
      repliesByQuestion: {},
    };
  }

  const updatePlaceholders = updateIds.map(() => '?').join(', ');
  const messages = await all(
    `
      SELECT sm.id, sm.onsite_update_id, sm.parent_message_id, sm.body, sm.created_at,
             u.name AS author_name, u.role AS author_role
      FROM stream_messages sm
      JOIN users u ON u.id = sm.author_user_id
      WHERE sm.company_id = ?
        AND sm.onsite_update_id IN (${updatePlaceholders})
      ORDER BY sm.created_at ASC
    `,
    [user.companyId, ...updateIds]
  );

  const { questionsByUpdate, repliesByQuestion } = buildMessageMaps(messages);

  return {
    updates,
    questionsByUpdate,
    repliesByQuestion,
  };
}

async function loadAccessibleUpdateForUser(user, updateId) {
  const siteIds = await loadAccessibleSiteIdsForUser(user);
  if (!siteIds.length) {
    return null;
  }

  const sitePlaceholders = siteIds.map(() => '?').join(', ');
  const params = [Number(updateId), ...siteIds];
  let visibilitySql = 'AND ou.is_active = 1';
  if (user.role === 'client') {
    visibilitySql = "AND ou.is_active = 1 AND ou.visibility = 'staff_client'";
  }

  return get(
    `
      SELECT ou.id, ou.site_id, ou.title, ou.details, ou.occurrence_date, ou.occurrence_time,
             ou.general_location, ou.client_notified, ou.image_path, ou.attachment_name,
             ou.attachment_mime, ou.visibility, ou.created_at,
             s.name AS site_name, u.name AS author_name
      FROM onsite_updates ou
      JOIN sites s ON s.id = ou.site_id
      JOIN users u ON u.id = ou.created_by
      WHERE ou.id = ?
        AND ou.site_id IN (${sitePlaceholders})
        ${visibilitySql}
      LIMIT 1
    `,
    params
  );
}

app.get('/', async (req, res) => {
  if (req.session.user) {
    res.redirect(dashboardRouteForRole(req.session.user.role));
    return;
  }
  const companies = await all('SELECT id, name FROM companies ORDER BY name');
  res.render('index', { companies });
});

app.get('/register', async (req, res) => {
  const companies = await all('SELECT id, name FROM companies ORDER BY name');
  res.render('register', { companies });
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, companyMode, companyId, companyName } = req.body;

    if (!name || !email || !password || !role) {
      req.session.error = 'Name, email, password, and role are required.';
      res.redirect('/register');
      return;
    }

    if (!['company_admin', 'manager', 'employee', 'client'].includes(role)) {
      req.session.error = 'Invalid role selection.';
      res.redirect('/register');
      return;
    }

    const existing = await get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (existing) {
      req.session.error = 'An account with that email already exists.';
      res.redirect('/register');
      return;
    }

    let finalCompanyId;

    if (companyMode === 'new') {
      if (!companyName || !companyName.trim()) {
        req.session.error = 'Company name is required when creating a new company.';
        res.redirect('/register');
        return;
      }

      const existingCompany = await get('SELECT id FROM companies WHERE name = ?', [companyName.trim()]);
      if (existingCompany) {
        finalCompanyId = existingCompany.id;
      } else {
        const companyInsert = await run('INSERT INTO companies (name) VALUES (?)', [companyName.trim()]);
        finalCompanyId = companyInsert.lastID;
      }
    } else {
      if (!companyId) {
        req.session.error = 'Please select an existing company.';
        res.redirect('/register');
        return;
      }
      finalCompanyId = Number(companyId);
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await run(
      `
        INSERT INTO users (name, email, password_hash, role, company_id)
        VALUES (?, ?, ?, ?, ?)
      `,
      [name.trim(), email.trim().toLowerCase(), passwordHash, role, finalCompanyId]
    );

    if (role === 'client') {
      await run(
        'INSERT INTO client_portal_links (user_id, token) VALUES (?, ?)',
        [userResult.lastID, createClientToken()]
      );
    }

    req.session.success = 'Account created. You can now sign in.';
    res.redirect('/login');
  } catch (error) {
    req.session.error = `Registration failed: ${error.message}`;
    res.redirect('/register');
  }
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      req.session.error = 'Email and password are required.';
      res.redirect('/login');
      return;
    }

    const user = await get(
      `
        SELECT u.id, u.name, u.email, u.password_hash, u.role, u.company_id, u.active, c.name AS company_name
        FROM users u
        JOIN companies c ON c.id = u.company_id
        WHERE u.email = ?
      `,
      [email.trim().toLowerCase()]
    );

    if (!user) {
      req.session.error = 'Invalid credentials.';
      res.redirect('/login');
      return;
    }

    if (!user.active) {
      req.session.error = 'Your account is inactive. Contact an administrator.';
      res.redirect('/login');
      return;
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      req.session.error = 'Invalid credentials.';
      res.redirect('/login');
      return;
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      companyId: user.company_id,
      companyName: user.company_name,
      isEmployeeDemo: user.role === 'employee' && user.email === DEMO_EMPLOYEE_EMAIL,
    };

    res.redirect(dashboardRouteForRole(user.role));
  } catch (error) {
    req.session.error = `Login failed: ${error.message}`;
    res.redirect('/login');
  }
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/admin', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  const companyId = req.session.user.companyId;

  const [company, users, sites, updates, issues, messages, auditLogs] = await Promise.all([
    get('SELECT id, name FROM companies WHERE id = ?', [companyId]),
    all(
      `
        SELECT id, name, email, role, active, created_at
        FROM users
        WHERE company_id = ?
        ORDER BY role, name
      `,
      [companyId]
    ),
    all(
      `
        SELECT s.id, s.name, s.address, s.manager_representative, u.name AS created_by_name, s.created_at
        FROM sites s
        JOIN users u ON u.id = s.created_by
        WHERE s.company_id = ?
        ORDER BY s.name
      `,
      [companyId]
    ),
    all(
      `
        SELECT ou.id, ou.title, ou.occurrence_date, ou.occurrence_time, ou.visibility,
               ou.image_path, ou.is_active, s.name AS site_name, u.name AS author_name, ou.created_at
        FROM onsite_updates ou
        JOIN sites s ON s.id = ou.site_id
        JOIN users u ON u.id = ou.created_by
        WHERE s.company_id = ?
        ORDER BY ou.created_at DESC
        LIMIT 50
      `,
      [companyId]
    ),
    all(
      `
        SELECT si.id, si.title, si.status, s.name AS site_name, u.name AS author_name, si.created_at
        FROM site_issues si
        JOIN sites s ON s.id = si.site_id
        JOIN users u ON u.id = si.created_by
        WHERE s.company_id = ?
        ORDER BY si.created_at DESC
        LIMIT 50
      `,
      [companyId]
    ),
    all(
      `
        SELECT dm.id, dm.subject, dm.created_at, dm.read_at, fu.name AS from_name, tu.name AS to_name, s.name AS site_name
        FROM direct_messages dm
        JOIN users fu ON fu.id = dm.from_user_id
        JOIN users tu ON tu.id = dm.to_user_id
        LEFT JOIN sites s ON s.id = dm.site_id
        WHERE dm.company_id = ?
        ORDER BY dm.created_at DESC
        LIMIT 50
      `,
      [companyId]
    ),
    all(
      `
        SELECT al.id, al.action, al.entity_type, al.entity_id, al.details, al.created_at, u.name AS actor_name
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.actor_user_id
        WHERE al.company_id = ?
        ORDER BY al.created_at DESC
        LIMIT 100
      `,
      [companyId]
    ),
  ]);

  const accessRows = await all(
    `
      SELECT sua.user_id, sua.site_id, sua.can_post_updates
      FROM site_user_access sua
      JOIN users u ON u.id = sua.user_id
      JOIN sites s ON s.id = sua.site_id
      WHERE u.company_id = ? AND s.company_id = ?
    `,
    [companyId, companyId]
  );

  const accessMap = {};
  accessRows.forEach((row) => {
    accessMap[`${row.user_id}-${row.site_id}`] = row.can_post_updates;
  });

  const clientPortalLinks = await all(
    `
      SELECT cpl.token, u.id AS user_id, u.name AS user_name
      FROM client_portal_links cpl
      JOIN users u ON u.id = cpl.user_id
      WHERE u.company_id = ? AND u.role = 'client'
      ORDER BY u.name
    `,
    [companyId]
  );

  res.render('admin', {
    company,
    users,
    sites,
    updates,
    issues,
    messages,
    auditLogs,
    accessMap,
    clientPortalLinks,
  });
});

app.get('/admin/wizard', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  const [company, sites] = await Promise.all([
    get('SELECT id, name FROM companies WHERE id = ?', [req.session.user.companyId]),
    all('SELECT id, name FROM sites WHERE company_id = ? ORDER BY name', [req.session.user.companyId]),
  ]);

  res.render('admin_wizard', {
    company,
    sites,
  });
});

app.post('/admin/wizard', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const companyId = req.session.user.companyId;
    const {
      companyName,
      siteName,
      siteAddress,
      siteManagerRepresentative,
      managerName,
      managerEmail,
      managerPassword,
      employeeName,
      employeeEmail,
      employeePassword,
      clientName,
      clientEmail,
      clientPassword,
    } = req.body;

    if (!siteName || !siteAddress) {
      req.session.error = 'Site name and address are required in the setup wizard.';
      res.redirect('/admin/wizard');
      return;
    }

    if (companyName && companyName.trim()) {
      await run('UPDATE companies SET name = ? WHERE id = ?', [companyName.trim(), companyId]);
      req.session.user.companyName = companyName.trim();
    }

    const siteInsert = await run(
      `
        INSERT INTO sites (company_id, name, address, manager_representative, created_by)
        VALUES (?, ?, ?, ?, ?)
      `,
      [companyId, siteName.trim(), siteAddress.trim(), (siteManagerRepresentative || '').trim(), req.session.user.id]
    );
    const siteId = siteInsert.lastID;

    const ensureUser = async ({ name, email, password, role }) => {
      if (!email || !email.trim()) {
        return null;
      }

      if (!password || !password.trim()) {
        throw new Error(`Password is required for ${role} user ${email}.`);
      }

      const normalizedEmail = email.trim().toLowerCase();
      const passwordHash = await bcrypt.hash(password, 10);
      const existingUser = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);

      if (existingUser) {
        await run(
          `
            UPDATE users
            SET name = ?, password_hash = ?, role = ?, company_id = ?, active = 1
            WHERE id = ?
          `,
          [(name || normalizedEmail).trim(), passwordHash, role, companyId, existingUser.id]
        );
        return existingUser.id;
      }

      const created = await run(
        `
          INSERT INTO users (name, email, password_hash, role, company_id, active)
          VALUES (?, ?, ?, ?, ?, 1)
        `,
        [(name || normalizedEmail).trim(), normalizedEmail, passwordHash, role, companyId]
      );

      return created.lastID;
    };

    const managerId = await ensureUser({
      name: managerName,
      email: managerEmail,
      password: managerPassword,
      role: 'manager',
    });

    const employeeId = await ensureUser({
      name: employeeName,
      email: employeeEmail,
      password: employeePassword,
      role: 'employee',
    });

    const clientId = await ensureUser({
      name: clientName,
      email: clientEmail,
      password: clientPassword,
      role: 'client',
    });

    const upsertSiteAccess = async (userId, canPostUpdates) => {
      if (!userId) {
        return;
      }

      await run(
        `
          INSERT INTO site_user_access (site_id, user_id, can_post_updates, approved_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(site_id, user_id)
          DO UPDATE SET can_post_updates = excluded.can_post_updates, approved_by = excluded.approved_by
        `,
        [siteId, userId, canPostUpdates, req.session.user.id]
      );
    };

    await Promise.all([
      upsertSiteAccess(managerId, 1),
      upsertSiteAccess(employeeId, 1),
      upsertSiteAccess(clientId, 0),
    ]);

    if (clientId) {
      const portalLink = await get('SELECT token FROM client_portal_links WHERE user_id = ?', [clientId]);
      if (!portalLink) {
        await run('INSERT INTO client_portal_links (user_id, token) VALUES (?, ?)', [clientId, createClientToken()]);
      }
    }

    await logAudit({
      companyId,
      actorUserId: req.session.user.id,
      action: 'wizard_completed',
      entityType: 'site',
      entityId: siteId,
      details: {
        siteName: siteName.trim(),
        managerEmail: managerEmail || null,
        employeeEmail: employeeEmail || null,
        clientEmail: clientEmail || null,
      },
    });

    req.session.success = 'Quick setup wizard completed. Site and users were configured.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Wizard setup failed: ${error.message}`;
    res.redirect('/admin/wizard');
  }
});

app.get('/admin/export/:kind.csv', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const companyId = req.session.user.companyId;
    const { kind } = req.params;

    if (kind === 'updates') {
      const rows = await all(
        `
          SELECT ou.id, s.name AS site_name, u.name AS author_name, ou.title, ou.details,
                 ou.occurrence_date, ou.occurrence_time, ou.general_location,
                 ou.client_notified, ou.visibility, ou.is_active, ou.created_at
          FROM onsite_updates ou
          JOIN sites s ON s.id = ou.site_id
          JOIN users u ON u.id = ou.created_by
          WHERE s.company_id = ?
          ORDER BY ou.created_at DESC
        `,
        [companyId]
      );

      sendCsv(res, 'onsite-updates.csv', rows, [
        { key: 'id', header: 'id' },
        { key: 'site_name', header: 'site_name' },
        { key: 'author_name', header: 'author_name' },
        { key: 'title', header: 'title' },
        { key: 'details', header: 'details' },
        { key: 'occurrence_date', header: 'occurrence_date' },
        { key: 'occurrence_time', header: 'occurrence_time' },
        { key: 'general_location', header: 'general_location' },
        { key: 'client_notified', header: 'client_notified' },
        { key: 'visibility', header: 'visibility' },
        { key: 'is_active', header: 'is_active' },
        { key: 'created_at', header: 'created_at' },
      ]);
      return;
    }

    if (kind === 'issues') {
      const rows = await all(
        `
          SELECT si.id, s.name AS site_name, u.name AS author_name, si.title, si.details, si.status, si.created_at
          FROM site_issues si
          JOIN sites s ON s.id = si.site_id
          JOIN users u ON u.id = si.created_by
          WHERE s.company_id = ?
          ORDER BY si.created_at DESC
        `,
        [companyId]
      );

      sendCsv(res, 'site-issues.csv', rows, [
        { key: 'id', header: 'id' },
        { key: 'site_name', header: 'site_name' },
        { key: 'author_name', header: 'author_name' },
        { key: 'title', header: 'title' },
        { key: 'details', header: 'details' },
        { key: 'status', header: 'status' },
        { key: 'created_at', header: 'created_at' },
      ]);
      return;
    }

    if (kind === 'messages') {
      const rows = await all(
        `
          SELECT dm.id, fu.name AS from_name, tu.name AS to_name, s.name AS site_name,
                 dm.subject, dm.body, dm.created_at, dm.read_at
          FROM direct_messages dm
          JOIN users fu ON fu.id = dm.from_user_id
          JOIN users tu ON tu.id = dm.to_user_id
          LEFT JOIN sites s ON s.id = dm.site_id
          WHERE dm.company_id = ?
          ORDER BY dm.created_at DESC
        `,
        [companyId]
      );

      sendCsv(res, 'direct-messages.csv', rows, [
        { key: 'id', header: 'id' },
        { key: 'from_name', header: 'from_name' },
        { key: 'to_name', header: 'to_name' },
        { key: 'site_name', header: 'site_name' },
        { key: 'subject', header: 'subject' },
        { key: 'body', header: 'body' },
        { key: 'created_at', header: 'created_at' },
        { key: 'read_at', header: 'read_at' },
      ]);
      return;
    }

    if (kind === 'audit') {
      const rows = await all(
        `
          SELECT al.id, u.name AS actor_name, al.action, al.entity_type, al.entity_id, al.details, al.created_at
          FROM audit_logs al
          LEFT JOIN users u ON u.id = al.actor_user_id
          WHERE al.company_id = ?
          ORDER BY al.created_at DESC
        `,
        [companyId]
      );

      sendCsv(res, 'audit-log.csv', rows, [
        { key: 'id', header: 'id' },
        { key: 'actor_name', header: 'actor_name' },
        { key: 'action', header: 'action' },
        { key: 'entity_type', header: 'entity_type' },
        { key: 'entity_id', header: 'entity_id' },
        { key: 'details', header: 'details' },
        { key: 'created_at', header: 'created_at' },
      ]);
      return;
    }

    req.session.error = 'Unknown export type.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Export failed: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/company', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      req.session.error = 'Company name is required.';
      res.redirect('/admin');
      return;
    }

    await run('UPDATE companies SET name = ? WHERE id = ?', [name.trim(), req.session.user.companyId]);
    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'company_updated',
      entityType: 'company',
      entityId: req.session.user.companyId,
      details: { name: name.trim() },
    });
    req.session.user.companyName = name.trim();
    req.session.success = 'Company profile updated.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to update company: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/sites', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const { name, address, managerRepresentative } = req.body;

    if (!name || !address) {
      req.session.error = 'Site name and address are required.';
      res.redirect('/admin');
      return;
    }

    const insertedSite = await run(
      `
        INSERT INTO sites (company_id, name, address, manager_representative, created_by)
        VALUES (?, ?, ?, ?, ?)
      `,
      [req.session.user.companyId, name.trim(), address.trim(), (managerRepresentative || '').trim(), req.session.user.id]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'site_created',
      entityType: 'site',
      entityId: insertedSite.lastID,
      details: { name: name.trim(), address: address.trim() },
    });

    req.session.success = 'Site profile created.';
    res.redirect('/');
  } catch (error) {
    req.session.error = `Unable to create site: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/sites/:id/update', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const siteId = Number(req.params.id);
    const { name, address, managerRepresentative } = req.body;

    const site = await get('SELECT id FROM sites WHERE id = ? AND company_id = ?', [siteId, req.session.user.companyId]);
    if (!site) {
      req.session.error = 'Site not found.';
      res.redirect('/admin');
      return;
    }

    await run(
      `
        UPDATE sites
        SET name = ?, address = ?, manager_representative = ?
        WHERE id = ?
      `,
      [name.trim(), address.trim(), (managerRepresentative || '').trim(), siteId]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'site_updated',
      entityType: 'site',
      entityId: siteId,
      details: { name: name.trim(), address: address.trim() },
    });

    req.session.success = 'Site profile updated.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to update site: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/access', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const siteId = Number(req.body.siteId);
    const canPostUpdates = Number(req.body.canPostUpdates || 0);

    if (!userId || !siteId) {
      req.session.error = 'User and site are required for access approvals.';
      res.redirect('/admin');
      return;
    }

    const [user, site] = await Promise.all([
      get('SELECT id FROM users WHERE id = ? AND company_id = ?', [userId, req.session.user.companyId]),
      get('SELECT id FROM sites WHERE id = ? AND company_id = ?', [siteId, req.session.user.companyId]),
    ]);

    if (!user || !site) {
      req.session.error = 'Invalid user or site for this company.';
      res.redirect('/admin');
      return;
    }

    await run(
      `
        INSERT INTO site_user_access (site_id, user_id, can_post_updates, approved_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(site_id, user_id)
        DO UPDATE SET can_post_updates = excluded.can_post_updates, approved_by = excluded.approved_by
      `,
      [siteId, userId, canPostUpdates ? 1 : 0, req.session.user.id]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'site_access_updated',
      entityType: 'site_access',
      entityId: siteId,
      details: { userId, canPostUpdates: canPostUpdates ? 1 : 0 },
    });

    req.session.success = 'Site access updated.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to update access: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/users/:id/toggle-active', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = await get(
      'SELECT id, role, active FROM users WHERE id = ? AND company_id = ?',
      [userId, req.session.user.companyId]
    );

    if (!user) {
      req.session.error = 'User not found.';
      res.redirect('/admin');
      return;
    }

    if (user.id === req.session.user.id) {
      req.session.error = 'You cannot deactivate your own account.';
      res.redirect('/admin');
      return;
    }

    await run('UPDATE users SET active = ? WHERE id = ?', [user.active ? 0 : 1, user.id]);

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'user_status_toggled',
      entityType: 'user',
      entityId: user.id,
      details: { active: user.active ? 0 : 1 },
    });

    req.session.success = 'User status updated.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to toggle user status: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/issues/:id/status', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const issueId = Number(req.params.id);
    const { status } = req.body;

    if (!['open', 'in_review', 'resolved'].includes(status)) {
      req.session.error = 'Invalid issue status.';
      res.redirect('/admin');
      return;
    }

    const issue = await get(
      `
        SELECT si.id
        FROM site_issues si
        JOIN sites s ON s.id = si.site_id
        WHERE si.id = ? AND s.company_id = ?
      `,
      [issueId, req.session.user.companyId]
    );

    if (!issue) {
      req.session.error = 'Issue not found.';
      res.redirect('/admin');
      return;
    }

    await run('UPDATE site_issues SET status = ? WHERE id = ?', [status, issueId]);

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'issue_status_updated',
      entityType: 'site_issue',
      entityId: issueId,
      details: { status },
    });

    req.session.success = 'Issue status updated.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to update issue status: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/updates/:id/deactivate', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);

    const update = await get(
      `
        SELECT ou.id
        FROM onsite_updates ou
        JOIN sites s ON s.id = ou.site_id
        WHERE ou.id = ? AND s.company_id = ?
      `,
      [updateId, req.session.user.companyId]
    );

    if (!update) {
      req.session.error = 'Update not found.';
      res.redirect('/admin');
      return;
    }

    await run('UPDATE onsite_updates SET is_active = 0 WHERE id = ?', [updateId]);
    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'update_deactivated',
      entityType: 'onsite_update',
      entityId: updateId,
    });
    req.session.success = 'Document deactivated. It is hidden but not deleted.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to deactivate document: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/updates/:id/reactivate', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);

    const update = await get(
      `
        SELECT ou.id
        FROM onsite_updates ou
        JOIN sites s ON s.id = ou.site_id
        WHERE ou.id = ? AND s.company_id = ?
      `,
      [updateId, req.session.user.companyId]
    );

    if (!update) {
      req.session.error = 'Update not found.';
      res.redirect('/admin');
      return;
    }

    await run('UPDATE onsite_updates SET is_active = 1 WHERE id = ?', [updateId]);
    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'update_reactivated',
      entityType: 'onsite_update',
      entityId: updateId,
    });
    req.session.success = 'Document reactivated.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to reactivate document: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/updates/:id/delete-permanent', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);

    const update = await get(
      `
        SELECT ou.id, ou.image_path
        FROM onsite_updates ou
        JOIN sites s ON s.id = ou.site_id
        WHERE ou.id = ? AND s.company_id = ?
      `,
      [updateId, req.session.user.companyId]
    );

    if (!update) {
      req.session.error = 'Update not found.';
      res.redirect('/admin');
      return;
    }

    await run('DELETE FROM onsite_updates WHERE id = ?', [updateId]);
    await removeUploadedFile(update.image_path);
    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'update_deleted_permanent',
      entityType: 'onsite_update',
      entityId: updateId,
    });
    req.session.success = 'Document permanently deleted.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to permanently delete document: ${error.message}`;
    res.redirect('/admin');
  }
});

app.post('/admin/messages/:id/read', requireAuth, requireRole('company_admin', 'manager'), async (req, res) => {
  try {
    const messageId = Number(req.params.id);

    const message = await get(
      `
        SELECT id
        FROM direct_messages
        WHERE id = ? AND company_id = ? AND to_user_id = ?
      `,
      [messageId, req.session.user.companyId, req.session.user.id]
    );

    if (!message) {
      req.session.error = 'Message not found.';
      res.redirect('/admin');
      return;
    }

    await run('UPDATE direct_messages SET read_at = CURRENT_TIMESTAMP WHERE id = ?', [messageId]);
    req.session.success = 'Message marked as read.';
    res.redirect('/admin');
  } catch (error) {
    req.session.error = `Unable to update message: ${error.message}`;
    res.redirect('/admin');
  }
});

app.get('/employee', requireAuth, requireRole('employee'), async (req, res) => {
  const isEmployeeDemo = req.session.user.isEmployeeDemo === true;
  const approvedSites = await loadApprovedSitesForUser(req.session.user.id, req.session.user.companyId);
  const postableSites = approvedSites.filter((site) => site.can_post_updates === 1);

  const approvedSiteIds = approvedSites.map((site) => site.id);

  if (!approvedSiteIds.length) {
    res.render('employee', {
      isEmployeeDemo,
      approvedSites,
      postableSites,
      updates: [],
      issues: [],
    });
    return;
  }

  const approvedSitePlaceholders = approvedSiteIds.map(() => '?').join(', ');

  const updates = await all(
    `
      SELECT ou.id, ou.title, ou.details, ou.occurrence_date, ou.occurrence_time, ou.general_location,
             ou.client_notified, ou.image_path, ou.attachment_name, ou.attachment_mime,
             ou.visibility, ou.is_active, ou.created_at, s.name AS site_name, u.name AS author_name
      FROM onsite_updates ou
      JOIN sites s ON s.id = ou.site_id
      JOIN users u ON u.id = ou.created_by
      WHERE ou.site_id IN (${approvedSitePlaceholders})
      ORDER BY ou.created_at DESC
      LIMIT 50
    `,
    approvedSiteIds
  );

  const issues = isEmployeeDemo
    ? []
    : await all(
      `
        SELECT si.id, si.title, si.details, si.status, si.created_at, s.name AS site_name, u.name AS author_name
        FROM site_issues si
        JOIN sites s ON s.id = si.site_id
        JOIN users u ON u.id = si.created_by
        WHERE si.site_id IN (${approvedSitePlaceholders})
        ORDER BY si.created_at DESC
        LIMIT 50
      `,
      approvedSiteIds
    );

  res.render('employee', {
    isEmployeeDemo,
    approvedSites,
    postableSites,
    updates,
    issues,
  });
});

app.post('/employee/onsite-updates/:id/deactivate', requireAuth, requireRole('employee'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);
    const update = await get('SELECT id FROM onsite_updates WHERE id = ? AND created_by = ?', [updateId, req.session.user.id]);

    if (!update) {
      req.session.error = 'Document not found.';
      res.redirect('/employee');
      return;
    }

    await run('UPDATE onsite_updates SET is_active = 0 WHERE id = ?', [updateId]);
    req.session.success = 'Document deactivated. It was not deleted.';
    res.redirect('/employee');
  } catch (error) {
    req.session.error = `Unable to deactivate document: ${error.message}`;
    res.redirect('/employee');
  }
});

app.post('/employee/onsite-updates/:id/reactivate', requireAuth, requireRole('employee'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);
    const update = await get('SELECT id FROM onsite_updates WHERE id = ? AND created_by = ?', [updateId, req.session.user.id]);

    if (!update) {
      req.session.error = 'Document not found.';
      res.redirect('/employee');
      return;
    }

    await run('UPDATE onsite_updates SET is_active = 1 WHERE id = ?', [updateId]);
    req.session.success = 'Document reactivated.';
    res.redirect('/employee');
  } catch (error) {
    req.session.error = `Unable to reactivate document: ${error.message}`;
    res.redirect('/employee');
  }
});

app.post('/employee/onsite-updates/:id/delete-permanent', requireAuth, requireRole('employee'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);
    const update = await get(
      'SELECT id, image_path FROM onsite_updates WHERE id = ? AND created_by = ?',
      [updateId, req.session.user.id]
    );

    if (!update) {
      req.session.error = 'Document not found.';
      res.redirect('/employee');
      return;
    }

    await run('DELETE FROM onsite_updates WHERE id = ?', [updateId]);
    await removeUploadedFile(update.image_path);
    req.session.success = 'Document permanently deleted.';
    res.redirect('/employee');
  } catch (error) {
    req.session.error = `Unable to permanently delete document: ${error.message}`;
    res.redirect('/employee');
  }
});

app.post('/employee/onsite-updates', requireAuth, requireRole('employee'), upload.single('attachment'), async (req, res) => {
  try {
    const isEmployeeDemo = req.session.user.isEmployeeDemo === true;
    const {
      siteId,
      title,
      details,
      occurrenceDate,
      occurrenceTime,
      generalLocation,
      clientNotified,
      visibility,
    } = req.body;

    if (!siteId || !title || !details || !occurrenceDate || !occurrenceTime || !generalLocation) {
      req.session.error = 'All required onsite update fields must be filled in.';
      res.redirect('/employee');
      return;
    }

    const access = await get(
      `
        SELECT sua.site_id
        FROM site_user_access sua
        JOIN sites s ON s.id = sua.site_id
        WHERE sua.user_id = ?
          AND sua.site_id = ?
          AND sua.can_post_updates = 1
          AND s.company_id = ?
      `,
      [req.session.user.id, Number(siteId), req.session.user.companyId]
    );

    if (!access) {
      req.session.error = 'You are not approved to post updates for that site.';
      res.redirect('/employee');
      return;
    }

    const finalClientNotified = isEmployeeDemo ? '' : (clientNotified || '').trim();
    const finalVisibility = isEmployeeDemo
      ? 'staff_only'
      : (visibility === 'staff_only' ? 'staff_only' : 'staff_client');

    const createdUpdate = await run(
      `
        INSERT INTO onsite_updates (
          site_id,
          created_by,
          title,
          details,
          occurrence_date,
          occurrence_time,
          general_location,
          client_notified,
          image_path,
          attachment_name,
          attachment_mime,
          visibility
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        Number(siteId),
        req.session.user.id,
        title.trim(),
        details.trim(),
        occurrenceDate,
        occurrenceTime,
        generalLocation.trim(),
        finalClientNotified,
        req.file ? `/uploads/${req.file.filename}` : null,
        req.file ? req.file.originalname : null,
        req.file ? req.file.mimetype : null,
        finalVisibility,
      ]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'employee_update_posted',
      entityType: 'onsite_update',
      entityId: createdUpdate.lastID,
      details: { siteId: Number(siteId), visibility: finalVisibility },
    });

    req.session.success = 'Onsite update posted.';
    res.redirect('/employee');
  } catch (error) {
    req.session.error = `Unable to post onsite update: ${error.message}`;
    res.redirect('/employee');
  }
});

app.post('/employee/site-issues', requireAuth, requireRole('employee'), async (req, res) => {
  try {
    if (req.session.user.isEmployeeDemo === true) {
      req.session.error = 'Demo employee portal only supports onsite updates.';
      res.redirect('/employee');
      return;
    }

    const { siteId, title, details } = req.body;

    if (!siteId || !title || !details) {
      req.session.error = 'Site, title, and issue details are required.';
      res.redirect('/employee');
      return;
    }

    const access = await get(
      `
        SELECT sua.site_id
        FROM site_user_access sua
        JOIN sites s ON s.id = sua.site_id
        WHERE sua.user_id = ?
          AND sua.site_id = ?
          AND s.company_id = ?
      `,
      [req.session.user.id, Number(siteId), req.session.user.companyId]
    );

    if (!access) {
      req.session.error = 'You are not approved for that site.';
      res.redirect('/employee');
      return;
    }

    const createdIssue = await run(
      `
        INSERT INTO site_issues (site_id, created_by, title, details)
        VALUES (?, ?, ?, ?)
      `,
      [Number(siteId), req.session.user.id, title.trim(), details.trim()]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'employee_issue_posted',
      entityType: 'site_issue',
      entityId: createdIssue.lastID,
      details: { siteId: Number(siteId) },
    });

    req.session.success = 'Site issue submitted.';
    res.redirect('/employee');
  } catch (error) {
    req.session.error = `Unable to submit issue: ${error.message}`;
    res.redirect('/employee');
  }
});

app.get('/updates/new', requireAuth, requireRole('company_admin', 'manager', 'employee'), async (req, res) => {
  let postableSites;

  if (req.session.user.role === 'employee') {
    const approvedSites = await loadApprovedSitesForUser(req.session.user.id, req.session.user.companyId);
    postableSites = approvedSites.filter((site) => site.can_post_updates === 1);
  } else {
    postableSites = await all(
      `
        SELECT s.id, s.name, s.address, s.manager_representative, 1 AS can_post_updates
        FROM sites s
        WHERE s.company_id = ?
        ORDER BY s.name
      `,
      [req.session.user.companyId]
    );
  }

  res.render('update_new', {
    postableSites,
  });
});

app.post('/updates/new', requireAuth, requireRole('company_admin', 'manager', 'employee'), upload.single('attachment'), async (req, res) => {
  try {
    const {
      siteId,
      title,
      details,
      occurrenceDate,
      occurrenceTime,
      generalLocation,
      clientNotified,
      visibility,
    } = req.body;

    if (!siteId || !title || !details || !occurrenceDate || !occurrenceTime || !generalLocation) {
      req.session.error = 'All required fields must be completed to post an update.';
      res.redirect('/updates/new');
      return;
    }

    const site = await get('SELECT id, company_id FROM sites WHERE id = ?', [Number(siteId)]);
    if (!site || site.company_id !== req.session.user.companyId) {
      req.session.error = 'Selected site is invalid for your company.';
      res.redirect('/updates/new');
      return;
    }

    if (req.session.user.role === 'employee') {
      const access = await get(
        `
          SELECT 1 AS ok
          FROM site_user_access
          WHERE site_id = ? AND user_id = ? AND can_post_updates = 1
        `,
        [Number(siteId), req.session.user.id]
      );

      if (!access) {
        req.session.error = 'You are not approved to post updates for this site.';
        res.redirect('/updates/new');
        return;
      }
    }

    const inserted = await run(
      `
        INSERT INTO onsite_updates (
          site_id,
          created_by,
          title,
          details,
          occurrence_date,
          occurrence_time,
          general_location,
          client_notified,
          image_path,
          attachment_name,
          attachment_mime,
          visibility
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        Number(siteId),
        req.session.user.id,
        title.trim(),
        details.trim(),
        occurrenceDate,
        occurrenceTime,
        generalLocation.trim(),
        (clientNotified || '').trim(),
        req.file ? `/uploads/${req.file.filename}` : null,
        req.file ? req.file.originalname : null,
        req.file ? req.file.mimetype : null,
        visibility === 'staff_only' ? 'staff_only' : 'staff_client',
      ]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'update_posted_from_quick_add',
      entityType: 'onsite_update',
      entityId: inserted.lastID,
      details: {
        siteId: Number(siteId),
      },
    });

    req.session.success = 'Update posted successfully.';
    res.redirect('/');
  } catch (error) {
    req.session.error = `Unable to post update: ${error.message}`;
    res.redirect('/updates/new');
  }
});

app.get('/stream', requireAuth, requireRole('company_admin', 'manager', 'employee', 'client'), async (req, res) => {
  const streamData = await loadStreamDataForUser(req.session.user);

  res.render('stream', {
    updates: streamData.updates,
    questionsByUpdate: streamData.questionsByUpdate,
    repliesByQuestion: streamData.repliesByQuestion,
    isStaff: isStaffRole(req.session.user.role),
  });
});

app.get('/stream/update/:id', requireAuth, requireRole('company_admin', 'manager', 'employee', 'client'), async (req, res) => {
  const updateId = Number(req.params.id);
  const update = await loadAccessibleUpdateForUser(req.session.user, updateId);

  if (!update) {
    req.session.error = 'Update not found or not available in your access scope.';
    res.redirect('/stream');
    return;
  }

  const messages = await all(
    `
      SELECT sm.id, sm.onsite_update_id, sm.parent_message_id, sm.body, sm.created_at,
             u.id AS author_user_id, u.name AS author_name, u.role AS author_role
      FROM stream_messages sm
      JOIN users u ON u.id = sm.author_user_id
      WHERE sm.company_id = ?
        AND sm.onsite_update_id = ?
      ORDER BY sm.created_at ASC
    `,
    [req.session.user.companyId, updateId]
  );

  const { questionsByUpdate, repliesByQuestion } = buildMessageMaps(messages);
  const questions = questionsByUpdate[updateId] || [];

  res.render('stream_update', {
    update,
    questions,
    repliesByQuestion,
    isStaff: isStaffRole(req.session.user.role),
    canAskQuestion: req.session.user.role === 'client',
  });
});

app.post('/stream/update/:id/question', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const updateId = Number(req.params.id);
    const { body } = req.body;

    if (!body || !body.trim()) {
      req.session.error = 'Question text is required.';
      res.redirect(`/stream/update/${updateId}`);
      return;
    }

    const update = await loadAccessibleUpdateForUser(req.session.user, updateId);
    if (!update) {
      req.session.error = 'Update not found or unavailable for your account.';
      res.redirect('/stream');
      return;
    }

    await run(
      `
        INSERT INTO stream_messages (company_id, site_id, onsite_update_id, author_user_id, parent_message_id, body)
        VALUES (?, ?, ?, ?, NULL, ?)
      `,
      [req.session.user.companyId, update.site_id, updateId, req.session.user.id, body.trim()]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'stream_question_posted',
      entityType: 'onsite_update',
      entityId: updateId,
      details: { siteId: update.site_id },
    });

    req.session.success = 'Question posted to chat stream.';
    res.redirect(`/stream/update/${updateId}`);
  } catch (error) {
    req.session.error = `Unable to post question: ${error.message}`;
    res.redirect('/stream');
  }
});

app.post('/stream/message/:id/reply', requireAuth, requireRole('company_admin', 'manager', 'employee'), async (req, res) => {
  try {
    const parentMessageId = Number(req.params.id);
    const { body } = req.body;

    if (!body || !body.trim()) {
      req.session.error = 'Reply text is required.';
      res.redirect('/stream');
      return;
    }

    const parentMessage = await get(
      `
        SELECT sm.id, sm.company_id, sm.site_id, sm.onsite_update_id
        FROM stream_messages sm
        WHERE sm.id = ?
      `,
      [parentMessageId]
    );

    if (!parentMessage || parentMessage.company_id !== req.session.user.companyId) {
      req.session.error = 'Question not found.';
      res.redirect('/stream');
      return;
    }

    const update = await loadAccessibleUpdateForUser(req.session.user, parentMessage.onsite_update_id);
    if (!update) {
      req.session.error = 'You do not have access to reply on that update.';
      res.redirect('/stream');
      return;
    }

    await run(
      `
        INSERT INTO stream_messages (company_id, site_id, onsite_update_id, author_user_id, parent_message_id, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [req.session.user.companyId, parentMessage.site_id, parentMessage.onsite_update_id, req.session.user.id, parentMessageId, body.trim()]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'stream_reply_posted',
      entityType: 'stream_message',
      entityId: parentMessageId,
      details: { onsiteUpdateId: parentMessage.onsite_update_id },
    });

    req.session.success = 'Reply posted in chat stream.';
    res.redirect(`/stream/update/${parentMessage.onsite_update_id}`);
  } catch (error) {
    req.session.error = `Unable to post reply: ${error.message}`;
    res.redirect('/stream');
  }
});

async function buildClientPortalData(clientUserId, companyId) {
  const [approvedSites, updates, admins, portalLink] = await Promise.all([
    all(
      `
        SELECT s.id, s.name, s.address, s.manager_representative
        FROM site_user_access sua
        JOIN sites s ON s.id = sua.site_id
        WHERE sua.user_id = ? AND s.company_id = ?
        ORDER BY s.name
      `,
      [clientUserId, companyId]
    ),
    all(
      `
        SELECT ou.id, ou.title, ou.details, ou.occurrence_date, ou.occurrence_time,
               ou.general_location, ou.client_notified, ou.image_path, ou.created_at,
               s.id AS site_id, s.name AS site_name, u.name AS author_name
        FROM onsite_updates ou
        JOIN sites s ON s.id = ou.site_id
        JOIN site_user_access sua ON sua.site_id = s.id AND sua.user_id = ?
        JOIN users u ON u.id = ou.created_by
        WHERE s.company_id = ? AND ou.visibility = 'staff_client' AND ou.is_active = 1
        ORDER BY ou.created_at DESC
      `,
      [clientUserId, companyId]
    ),
    loadCompanyAdmins(companyId),
    get('SELECT token FROM client_portal_links WHERE user_id = ?', [clientUserId]),
  ]);

  return {
    approvedSites,
    updates,
    admins,
    portalLink,
  };
}

app.get('/client', requireAuth, requireRole('client'), async (req, res) => {
  const portal = await buildClientPortalData(req.session.user.id, req.session.user.companyId);

  res.render('client', {
    mode: 'loggedIn',
    token: null,
    ...portal,
  });
});

app.post('/client/message', requireAuth, requireRole('client'), async (req, res) => {
  try {
    const { siteId, toUserId, subject, body } = req.body;
    if (!toUserId || !subject || !body) {
      req.session.error = 'Recipient, subject, and message body are required.';
      res.redirect('/client');
      return;
    }

    const recipient = await get(
      'SELECT id FROM users WHERE id = ? AND role IN (\'company_admin\', \'manager\') AND company_id = ?',
      [Number(toUserId), req.session.user.companyId]
    );

    if (!recipient) {
      req.session.error = 'Recipient must be a company admin in your company.';
      res.redirect('/client');
      return;
    }

    let siteValue = null;
    if (siteId) {
      const siteAccess = await get(
        `
          SELECT s.id
          FROM site_user_access sua
          JOIN sites s ON s.id = sua.site_id
          WHERE sua.user_id = ? AND sua.site_id = ? AND s.company_id = ?
        `,
        [req.session.user.id, Number(siteId), req.session.user.companyId]
      );
      if (siteAccess) {
        siteValue = siteAccess.id;
      }
    }

    const createdMessage = await run(
      `
        INSERT INTO direct_messages (company_id, site_id, from_user_id, to_user_id, subject, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [req.session.user.companyId, siteValue, req.session.user.id, recipient.id, subject.trim(), body.trim()]
    );

    await logAudit({
      companyId: req.session.user.companyId,
      actorUserId: req.session.user.id,
      action: 'client_message_sent',
      entityType: 'direct_message',
      entityId: createdMessage.lastID,
      details: { siteId: siteValue, toUserId: recipient.id },
    });

    req.session.success = 'Message sent to admin/manager.';
    res.redirect('/client');
  } catch (error) {
    req.session.error = `Unable to send message: ${error.message}`;
    res.redirect('/client');
  }
});

app.get('/client/link/:token', async (req, res) => {
  const token = req.params.token;

  const client = await get(
    `
      SELECT u.id, u.name, u.company_id, c.name AS company_name
      FROM client_portal_links cpl
      JOIN users u ON u.id = cpl.user_id
      JOIN companies c ON c.id = u.company_id
      WHERE cpl.token = ? AND u.role = 'client' AND u.active = 1
    `,
    [token]
  );

  if (!client) {
    res.status(404).render('simple-message', {
      title: 'Invalid Client Link',
      message: 'This client link is not valid or has been disabled.',
    });
    return;
  }

  const portal = await buildClientPortalData(client.id, client.company_id);

  res.render('client', {
    mode: 'token',
    token,
    ...portal,
    tokenClient: client,
  });
});

app.post('/client/link/:token/message', async (req, res) => {
  try {
    const token = req.params.token;
    const { siteId, toUserId, subject, body } = req.body;

    const client = await get(
      `
        SELECT u.id, u.company_id
        FROM client_portal_links cpl
        JOIN users u ON u.id = cpl.user_id
        WHERE cpl.token = ? AND u.role = 'client' AND u.active = 1
      `,
      [token]
    );

    if (!client) {
      res.status(404).render('simple-message', {
        title: 'Invalid Client Link',
        message: 'This client link is not valid or has been disabled.',
      });
      return;
    }

    if (!toUserId || !subject || !body) {
      res.status(400).render('simple-message', {
        title: 'Missing Fields',
        message: 'Recipient, subject, and body are required to send a message.',
      });
      return;
    }

    const recipient = await get(
      'SELECT id FROM users WHERE id = ? AND role IN (\'company_admin\', \'manager\') AND company_id = ?',
      [Number(toUserId), client.company_id]
    );

    if (!recipient) {
      res.status(400).render('simple-message', {
        title: 'Invalid Recipient',
        message: 'Recipient must be an approved company admin.',
      });
      return;
    }

    let siteValue = null;
    if (siteId) {
      const access = await get(
        `
          SELECT s.id
          FROM site_user_access sua
          JOIN sites s ON s.id = sua.site_id
          WHERE sua.user_id = ? AND sua.site_id = ? AND s.company_id = ?
        `,
        [client.id, Number(siteId), client.company_id]
      );
      if (access) {
        siteValue = access.id;
      }
    }

    const createdMessage = await run(
      `
        INSERT INTO direct_messages (company_id, site_id, from_user_id, to_user_id, subject, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [client.company_id, siteValue, client.id, recipient.id, subject.trim(), body.trim()]
    );

    await logAudit({
      companyId: client.company_id,
      actorUserId: client.id,
      action: 'client_token_message_sent',
      entityType: 'direct_message',
      entityId: createdMessage.lastID,
      details: { siteId: siteValue, toUserId: recipient.id },
    });

    res.render('simple-message', {
      title: 'Message Sent',
      message: 'Your message has been sent to the manager/admin. You can close this page or go back.',
      backLink: withBasePath(`/client/link/${token}`),
    });
  } catch (error) {
    res.status(500).render('simple-message', {
      title: 'Message Error',
      message: `Could not send message: ${error.message}`,
    });
  }
});

app.use((err, req, res, next) => {
  if (
    err instanceof multer.MulterError
    || (typeof err.message === 'string' && (
      err.message.includes('image uploads')
      || err.message.includes('attachment')
      || err.message.includes('Unsupported')
    ))
  ) {
    req.session.error = err.message;
    res.redirect(req.headers.referer || '/');
    return;
  }

  console.error(err);
  res.status(500).render('simple-message', {
    title: 'Application Error',
    message: 'An unexpected error occurred. Please try again.',
  });
});

(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`PSLAW Portal running on http://localhost:${PORT}`);
  });
})();
