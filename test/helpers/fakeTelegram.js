import http from 'node:http';

/**
 * A tiny fake Telegram Bot API server. Telegraf is pointed at it via `telegram.apiRoot`, so the
 * real Telegraf client code path is exercised end-to-end.
 */
export async function startFakeTelegram({ botId = 999, botUsername = 'dupbot' } = {}) {
  const state = {
    calls: [],
    members: new Map(), // `${chatId}:${userId}` -> ChatMember
    users: new Map(), // userId -> User
    nextMessageId: new Map(),
    messages: new Map(), // `${chatId}:${messageId}` -> { text, reply_markup }
    deleted: [],
    failures: new Map(), // method -> [{ error_code, description, parameters }]
    rules: [], // { method, when(payload), error_code, description }
  };

  const me = { id: botId, is_bot: true, first_name: 'DupBot', username: botUsername };

  const nextId = (chatId) => {
    const n = (state.nextMessageId.get(chatId) ?? 10_000) + 1;
    state.nextMessageId.set(chatId, n);
    return n;
  };

  const handlers = {
    getMe: () => me,
    setMyCommands: () => true,
    deleteWebhook: () => true,
    sendMessage: (p) => {
      const message_id = nextId(p.chat_id);
      state.messages.set(`${p.chat_id}:${message_id}`, { text: p.text, reply_markup: p.reply_markup });
      return { message_id, date: Math.floor(Date.now() / 1000), chat: { id: p.chat_id, type: p.chat_id > 0 ? 'private' : 'supergroup' }, text: p.text };
    },
    editMessageText: (p) => {
      const key = `${p.chat_id}:${p.message_id}`;
      const prev = state.messages.get(key);
      if (prev && prev.text === p.text && JSON.stringify(prev.reply_markup ?? null) === JSON.stringify(p.reply_markup ?? null)) {
        throw { error_code: 400, description: 'Bad Request: message is not modified' };
      }
      state.messages.set(key, { text: p.text, reply_markup: p.reply_markup });
      return true;
    },
    editMessageReplyMarkup: () => true,
    answerCallbackQuery: () => true,
    deleteMessage: (p) => {
      state.deleted.push({ chatId: p.chat_id, messageId: p.message_id });
      return true;
    },
    getChatMember: (p) => {
      const m = state.members.get(`${p.chat_id}:${p.user_id}`);
      if (!m) return { status: 'left', user: state.users.get(p.user_id) ?? { id: p.user_id, is_bot: false, first_name: 'X' } };
      return m;
    },
    getChatAdministrators: (p) =>
      [...state.members.entries()]
        .filter(([key, m]) => key.startsWith(`${p.chat_id}:`) && ['creator', 'administrator'].includes(m.status))
        .map(([, m]) => m),
    getFile: (p) => ({ file_id: p.file_id, file_unique_id: `u_${p.file_id}`, file_path: `videos/${p.file_id}.mp4` }),
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = { raw: body };
      }
      state.calls.push({ method, payload });
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const rule = state.rules.find((r) => r.method === method && r.when(payload));
      if (rule) {
        send({ ok: false, error_code: rule.error_code, description: rule.description });
        return;
      }
      const queued = state.failures.get(method);
      if (queued?.length) {
        const f = queued.shift();
        send({ ok: false, error_code: f.error_code, description: f.description, parameters: f.parameters });
        return;
      }
      const handler = handlers[method];
      if (!handler) {
        send({ ok: false, error_code: 404, description: `fake: unknown method ${method}` });
        return;
      }
      try {
        send({ ok: true, result: handler(payload) });
      } catch (err) {
        send({ ok: false, error_code: err.error_code ?? 500, description: err.description ?? String(err) });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    apiRoot: `http://127.0.0.1:${port}`,
    me,
    state,
    setMember(chatId, user, status, extra = {}) {
      state.users.set(user.id, user);
      state.members.set(`${chatId}:${user.id}`, { status, user, ...extra });
    },
    failNext(method, error_code, description, parameters) {
      if (!state.failures.has(method)) state.failures.set(method, []);
      state.failures.get(method).push({ error_code, description, parameters });
    },
    failWhen(method, when, error_code, description) {
      state.rules.push({ method, when, error_code, description });
    },
    callsTo(method) {
      return state.calls.filter((c) => c.method === method).map((c) => c.payload);
    },
    reset() {
      state.calls.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
