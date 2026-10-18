const why = new URLSearchParams(location.search).get("error");
const msg = { domain: "That account isn't a Twelve Objects account. Sign in with your @twelveobjects.com address.", expired: "The sign-in took too long. Try again.", google: "Google didn't complete the sign-in. Try again." }[why];
if (msg) { const el = document.getElementById("err"); el.textContent = msg; el.hidden = false; }
