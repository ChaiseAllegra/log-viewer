import { ensureAuth, wireUserBox } from "./auth.js";

void ensureAuth().then(wireUserBox);
