export function createSession(user) {
  return {
    userId: user.id,
    createdAt: Date.now()
  };
}

export function verifySession(session) {
  return Boolean(session && session.userId);
}
