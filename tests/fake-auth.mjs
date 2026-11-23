// A stand-in for quarc-auth, for the browser tests only: any username/password
// signs in, the session is the same httpOnly JWT cookie the real service sets
// (signed with the same JWT_SECRET the Reader backend verifies).
import express from 'express';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'e2e-secret';
const PORT = Number(process.env.PORT || 3902);

const app = express();
app.use(express.json());

const userOf = (req) => {
  const m = /(?:^|;\s*)token=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  try {
    return jwt.verify(m[1], SECRET);
  } catch {
    return null;
  }
};

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  const user = { id: `user-${username}`, username, role: 'user' };
  const token = jwt.sign(user, SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json(user);
});
app.get('/api/auth/me', (req, res) => {
  const u = userOf(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: u.id, username: u.username, role: u.role });
});
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`fake-auth on :${PORT}`));
