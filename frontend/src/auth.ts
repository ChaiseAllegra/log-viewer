export interface User {
  user_name: string;
  permission: string;
}

const OVERLAY_HTML = `
  <div id="login-screen" class="login-screen hidden">
    <form id="login-form" class="login-card">
      <div class="brand">
        <span class="brand-dot"></span>
        <h1>Manufacturing Log Viewer</h1>
      </div>
      <h2>Sign in</h2>
      <input id="login-user" type="text" placeholder="Username" autocomplete="username" required />
      <input id="login-pass" type="password" placeholder="Password" autocomplete="current-password" required />
      <div id="login-error" class="login-error hidden"></div>
      <button class="btn btn-primary" type="submit">Sign in</button>
    </form>
  </div>`;

/** Resolves once the visitor has a valid session, showing the sign-in
 *  overlay first if needed. Every page awaits this before loading data. */
export function ensureAuth(): Promise<User> {
  document.body.insertAdjacentHTML("beforeend", OVERLAY_HTML);
  const screen = document.getElementById("login-screen")!;
  const form = document.getElementById("login-form") as HTMLFormElement;
  const error = document.getElementById("login-error")!;

  return new Promise((resolve) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.classList.add("hidden");
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_name: (document.getElementById("login-user") as HTMLInputElement).value.trim(),
          password: (document.getElementById("login-pass") as HTMLInputElement).value,
        }),
      });
      if (!res.ok) {
        error.textContent =
          res.status === 401 ? "Invalid username or password" : `Sign-in failed (${res.status})`;
        error.classList.remove("hidden");
        return;
      }
      const user = (await res.json()) as User;
      (document.getElementById("login-pass") as HTMLInputElement).value = "";
      screen.classList.add("hidden");
      resolve(user);
    });

    void (async () => {
      const res = await fetch("/api/me");
      if (res.ok) {
        resolve((await res.json()) as User);
      } else {
        screen.classList.remove("hidden");
      }
    })();
  });
}

/** Fills the header user box (if the page has one) and wires Sign out. */
export function wireUserBox(user: User): void {
  const box = document.getElementById("user-box");
  if (!box) return;
  box.classList.remove("hidden");
  const name = document.getElementById("user-name");
  if (name) name.textContent = user.user_name;
  document.getElementById("logout")?.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  });
}

/** Call when an API request returns 401 mid-session. */
export function sessionExpired(): void {
  location.reload();
}
