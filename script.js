// Chá Rifa da Laurinha — versão GitHub Pages + Firebase (tempo real)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, collection, onSnapshot, runTransaction,
  writeBatch, setDoc, serverTimestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";

/* =========================================================
   Utilidades
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const MAX_POR_PEDIDO = 20;

const DEFAULT_CONFIG = {
  titulo: "Chá Rifa da Laurinha",
  subtitulo: "Com muito amor para a nossa princesa!",
  premio: "R$ 300,00",
  totalNumeros: 200,
  pixMinimo: 30,
  chavePix: "+5513992070898",
  nomePix: "",
  whatsapp: "13 99207-0898",
  dataSorteio: "",
  comoSorteio: "O sorteio será feito entre os números confirmados, com transmissão para os participantes.",
  tamanhos: "RN, P, M, G, XG",
  mensagem: "Cada número comprado é um gesto de amor!",
  aceitandoPedidos: true
};

/* =========================================================
   Estado
   ========================================================= */
let config = { ...DEFAULT_CONFIG };
let sorteio = { numero: null, data: "" };
let numeros = {};                 // { "7": {s, nome, modo, tamanho, valor, obs, t, origem, pedido} }
let configLoaded = false, configExists = false, numerosLoaded = false, loadError = "";
let authUser = null, isAdmin = false;
let contatos = {};                // { pedido: {nome, telefone, numeros[]} } — só o organizador lê
let unsubContatos = null;

let view = "public", adminTab = "numeros";
let sel = [], asel = [];
let pubFilter = "todos", admFilter = "todos", admQuery = "";
let sheet = null;                 // painel de finalizar pedido
let ed = null;                    // editor do painel
let cfgDraft = null;              // formulário de configurações
let drawn = null, spinning = false, busy = false;

const total = () => Math.max(1, parseInt(config.totalNumeros, 10) || 200);
const pad = (n) => String(n).padStart(Math.max(2, String(total()).length), "0");
const firstName = (n) => { const p = String(n || "").trim().split(/\s+/); return p.length > 1 ? p[0] + " " + p[p.length - 1][0] + "." : p[0] || ""; };
const fmtDate = (d) => { if (!d) return ""; const p = d.split("-"); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d; };
const sizes = () => String(config.tamanhos || "").split(",").map((x) => x.trim()).filter(Boolean);
const waNumber = () => { let d = String(config.whatsapp || "").replace(/\D/g, ""); if (!d) return ""; if (d.length <= 11) d = "55" + d; return d; };
const digits = (s) => String(s || "").replace(/\D/g, "");
const telOk = (s) => /^[1-9]{2}9?[0-9]{8}$/.test(digits(s));
function fmtTel(s) {
  const d = digits(s);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return s || "";
}
function maskTel(v) {
  const d = digits(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
function novoPedido() {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}
const contatoDe = (n) => (n && n.pedido && contatos[n.pedido]) || null;
const tsDate = (t) => (t && typeof t.toDate === "function" ? t.toDate() : null);

function counts() {
  const c = { livre: 0, res: 0, pag: 0, fraldas: 0, pix: 0 };
  for (let i = 1; i <= total(); i++) {
    const n = numeros[i];
    if (!n) { c.livre++; continue; }
    if (n.s === "pago") { c.pag++; if (n.modo === "pix") c.pix += Number(n.valor) || 0; else c.fraldas++; }
    else c.res++;
  }
  return c;
}

function toast(t) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = t; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 3500);
}

function copy(text, el) {
  const fallback = () => {
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast("Texto selecionado. Copie com Ctrl+C ou segurando o dedo.");
  };
  try { navigator.clipboard.writeText(text).then(() => toast("Copiado!"), fallback); } catch { fallback(); }
}

/* =========================================================
   Firebase
   ========================================================= */
const configured = !String(firebaseConfig.apiKey || "").includes("COLE");
let db, auth;

if (!configured) {
  $("#app").innerHTML = `<div class="wrap"><div class="loading"><div>
    <h2 class="fd" style="color:var(--berry)">Falta configurar o Firebase</h2>
    <p>Abra o arquivo <code>firebase-config.js</code> e cole o bloco <code>firebaseConfig</code> do seu projeto.</p></div></div></div>`;
} else {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);

  onSnapshot(doc(db, "rifa", "config"), (d) => {
    configExists = d.exists();
    const x = d.exists() ? d.data() : {};
    config = { ...DEFAULT_CONFIG, ...(x.config || {}) };
    sorteio = x.sorteio || { numero: null, data: "" };
    configLoaded = true;
    seedConfigIfNeeded();
    onData();
  }, (e) => { loadError = e.code || "erro"; onData(); });

  onSnapshot(collection(db, "numeros"), (snap) => {
    const next = {};
    snap.forEach((d) => { next[d.id] = d.data(); });
    numeros = next;
    numerosLoaded = true;
    onData();
  }, (e) => { loadError = e.code || "erro"; onData(); });

  onAuthStateChanged(auth, (u) => {
    authUser = u;
    isAdmin = !!(u && u.email && u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (u && !isAdmin) {
      toast("Essa conta não tem acesso ao painel do organizador.");
      signOut(auth);
    }
    if (!isAdmin && view === "admin") view = "public";
    // Telefones: só carregam para o organizador
    if (isAdmin && !unsubContatos) {
      unsubContatos = onSnapshot(collection(db, "contatos"), (snap) => {
        const next = {}; snap.forEach((d) => { next[d.id] = d.data(); });
        contatos = next;
        if (view === "admin") refreshAdmin();
      }, (e) => console.error(e));
    }
    if (!isAdmin && unsubContatos) { unsubContatos(); unsubContatos = null; contatos = {}; }
    seedConfigIfNeeded();
    render();
  });
}

// Na primeira vez que o organizador entra, grava as configurações padrão no banco.
async function seedConfigIfNeeded() {
  if (!isAdmin || !configLoaded || configExists || seedConfigIfNeeded.done) return;
  seedConfigIfNeeded.done = true;
  try { await setDoc(doc(db, "rifa", "config"), { config: DEFAULT_CONFIG, sorteio: { numero: null, data: "" } }); }
  catch (e) { seedConfigIfNeeded.done = false; console.error(e); }
}

async function entrarOrganizador() {
  if (isAdmin) { view = "admin"; render(); scrollTo(0, 0); return; }
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    view = "admin"; render(); scrollTo(0, 0);
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast("Não foi possível entrar. Tente de novo.");
  }
}

/* =========================================================
   Atualização em tempo real
   ========================================================= */
function onData() {
  if (!configLoaded || !numerosLoaded) {
    if (loadError) render();
    return;
  }
  // Números que a pessoa tinha escolhido e alguém reservou antes
  const perdidos = sel.filter((n) => numeros[n]);
  if (perdidos.length) {
    sel = sel.filter((n) => !numeros[n]);
    toast(`Alguém acabou de reservar: ${perdidos.map(pad).join(", ")}. Escolha outro${perdidos.length > 1 ? "s" : ""}.`);
    if (sheet && sheet.stage === "form") { if (sel.length) renderSheet(); else closeSheet(); }
  }
  if (view === "admin" && isAdmin) refreshAdmin();
  else { const y = scrollY; renderPublic(); scrollTo(0, y); }
}

function render() {
  if (!configured) return;
  if (loadError && !(configLoaded && numerosLoaded)) {
    $("#app").innerHTML = `<div class="wrap"><div class="loading"><div><h2 class="fd" style="color:var(--berry)">Não foi possível carregar a rifa</h2><p>Confira a internet e recarregue a página. (${esc(loadError)})</p></div></div></div>`;
    return;
  }
  if (!configLoaded || !numerosLoaded) return;
  if (view === "admin" && isAdmin) renderAdmin();
  else { view = "public"; renderPublic(); }
}

/* =========================================================
   Ícones
   ========================================================= */
const heartSvg = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.7 1.2 5.2 3 1.5-1.8 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z"/></svg>';
const diaperSvg = '<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 8h24v5c0 7-5.5 12-12 12S4 20 4 13z" fill="#fff" stroke="#EC5B92" stroke-width="2"/><path d="M4 8h24v4H4z" fill="#FBDDE8" stroke="#EC5B92" stroke-width="2"/><path d="M16 15.5s-2.6-1.6-3.3-3.1c-.5-1.1.2-2.4 1.5-2.4.7 0 1.3.4 1.8 1 .5-.6 1.1-1 1.8-1 1.3 0 2 1.3 1.5 2.4-.7 1.5-3.3 3.1-3.3 3.1z" fill="#EC5B92" transform="translate(0 3)"/></svg>';
const pixSvg = '<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="7" width="18" height="18" rx="4" transform="rotate(45 16 16)" fill="#FBDDE8" stroke="#B32563" stroke-width="2"/><path d="M11 16h10M16 11v10" stroke="#B32563" stroke-width="2" stroke-linecap="round"/></svg>';
const checkSvg = '<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* =========================================================
   Página pública
   ========================================================= */
function topbar() {
  let right = "";
  if (isAdmin) {
    right = view === "public"
      ? '<button class="btn btn-soft btn-sm" id="toAdmin">Painel do organizador</button>'
      : '<button class="btn btn-soft btn-sm" id="toPublic">Ver página dos participantes</button>';
  }
  return `<header class="topbar"><div class="brand">${heartSvg}<span>${esc(config.titulo)}</span></div>${right}</header>`;
}
function bindTop() {
  const a = $("#toAdmin"), p = $("#toPublic");
  if (a) a.onclick = () => { view = "admin"; render(); scrollTo(0, 0); };
  if (p) p.onclick = () => { view = "public"; render(); scrollTo(0, 0); };
}
const chip = (v, l, cur, attr = "data-f") => `<button class="chip" ${attr}="${v}" aria-pressed="${cur === v}">${l}</button>`;

function renderPublic() {
  const c = counts(), T = total(), sold = c.res + c.pag, pct = Math.round((sold / T) * 100);
  const w = sorteio && sorteio.numero ? sorteio.numero : null, wn = w && numeros[w];

  let h = `<div class="wrap">${topbar()}
    <div class="hero"><img src="banner.jpg" alt="${esc(config.titulo)} — prêmio de ${esc(config.premio)}"></div>`;

  if (w) {
    h += `<div class="winner"><div class="ball tnum">${pad(w)}</div><div>
      <h2 class="fd" style="color:var(--berry);font-size:24px">Temos um ganhador!</h2>
      <p>O número sorteado foi o <b>${pad(w)}</b>${wn && wn.nome ? `, de <b>${esc(firstName(wn.nome))}</b>` : ""}${sorteio.data ? ` · sorteio em ${esc(fmtDate(sorteio.data))}` : ""}. Obrigado a todos que participaram!</p></div></div>`;
  }

  h += `<div class="info">
    <div class="card"><h3>Prêmio</h3><div class="big">${esc(config.premio)}</div><p>${esc(config.subtitulo)}</p></div>
    <div class="card"><h3>Sorteio</h3><div class="big">${config.dataSorteio ? esc(fmtDate(config.dataSorteio)) : "Data a definir"}</div><p>${esc(config.comoSorteio)}</p></div>
    <div class="card"><h3>Números escolhidos</h3><div class="big tnum">${sold} <span style="font-size:18px;color:var(--muted)">de ${T}</span></div>
      <div class="progress" role="img" aria-label="${pct}% dos números escolhidos"><span style="width:${pct}%"></span></div><p>${c.livre} ainda disponíveis</p></div>
  </div>

  <section class="ways"><h2>Como participar</h2><p class="lead">${esc(config.mensagem)} Escolha como quer contribuir por número:</p>
    <div class="ways-grid">
      <div class="card way"><div class="ico">${diaperSvg}</div><div><h3>1 pacote de fralda + 1 mimo</h3><p>Tamanhos que a Laurinha vai usar: ${esc(sizes().join(", ") || "qualquer")}. Você entrega no chá ou combina com a família.</p></div></div>
      <div class="card way"><div class="ico">${pixSvg}</div><div><h3>Pix a partir de ${money(config.pixMinimo)}</h3><p>Por número. Você escolhe o valor, a partir do mínimo. A chave Pix aparece ao finalizar.</p></div></div>
    </div>
    <ol class="steps"><li>Toque nos números que quiser</li><li>Escolha fralda + mimo ou Pix</li><li>Reserve e envie pelo WhatsApp</li><li>A família confirma seus números</li></ol>
  </section>

  <section class="board" aria-labelledby="bt"><div class="board-head"><div><h2 id="bt" class="script">Escolha seus números</h2>
    <div class="legend" style="margin-top:6px"><span><i></i>Disponível</span><span><i class="l-sel"></i>Sua escolha</span><span><i class="l-res"></i>Reservado</span><span><i class="l-pag"></i>Confirmado</span></div></div>
    <div class="chips" role="group" aria-label="Filtro">${chip("todos", "Todos", pubFilter)}${chip("livres", "Só disponíveis", pubFilter)}</div></div>`;

  if (!config.aceitandoPedidos) h += '<div class="closed">As escolhas estão encerradas. Obrigado pelo carinho!</div>';

  h += '<div class="grid" id="pgrid">';
  for (let i = 1; i <= T; i++) {
    const n = numeros[i];
    if (pubFilter === "livres" && n) continue;
    const isSel = sel.includes(i);
    const cls = "num" + (n ? (n.s === "pago" ? " pag" : " res") : "") + (isSel ? " sel" : "") + (w === i ? " win" : "");
    const lab = `Número ${pad(i)}` + (n ? (n.s === "pago" ? ", confirmado" : ", reservado") : isSel ? ", selecionado" : ", disponível");
    h += `<button class="${cls}" data-n="${i}" aria-label="${lab}"${n ? "" : ` aria-pressed="${isSel}"`}>${pad(i)}${n && n.nome ? `<small>${esc(firstName(n.nome).split(" ")[0])}</small>` : ""}</button>`;
  }
  h += `</div></section>
    <footer class="footer"><button class="linkbtn" id="orgLogin">${isAdmin ? "Painel do organizador" : "Área do organizador"}</button></footer>
  </div>`;

  if (sel.length && !sheet) {
    h += `<div class="selbar"><div class="in"><div><b class="tnum">${sel.length} número${sel.length > 1 ? "s" : ""}</b><div class="list tnum">${sel.map(pad).join(", ")}</div></div>
      <div class="acts"><button class="btn btn-ghost" id="clr">Limpar</button><button class="btn btn-primary" id="go">Continuar ${heartSvg}</button></div></div></div>`;
  }

  $("#app").innerHTML = h;
  bindTop();

  $("#pgrid").addEventListener("click", (e) => {
    const b = e.target.closest(".num"); if (!b) return;
    const i = +b.dataset.n, n = numeros[i];
    if (n) { toast(`Nº ${pad(i)} já foi ${n.s === "pago" ? "confirmado" : "reservado"}${n.nome ? " por " + firstName(n.nome) : ""}.`); return; }
    if (!config.aceitandoPedidos) { toast("As escolhas estão encerradas."); return; }
    const k = sel.indexOf(i);
    if (k >= 0) sel.splice(k, 1);
    else {
      if (sel.length >= MAX_POR_PEDIDO) { toast(`Máximo de ${MAX_POR_PEDIDO} números por pedido.`); return; }
      sel.push(i); sel.sort((a, b) => a - b);
    }
    const y = scrollY; renderPublic(); scrollTo(0, y);
  });
  $$(".chip[data-f]").forEach((b) => { b.onclick = () => { pubFilter = b.dataset.f; renderPublic(); }; });
  const clr = $("#clr"), go = $("#go");
  if (clr) clr.onclick = () => { sel = []; renderPublic(); };
  if (go) go.onclick = () => {
    let salvo = {};
    try { salvo = JSON.parse(localStorage.getItem("rifa-contato") || "{}"); } catch { /* sem armazenamento */ }
    sheet = { stage: "form", modo: "fralda", nome: salvo.nome || "", telefone: salvo.telefone || "", tamanho: sizes()[0] || "", valor: config.pixMinimo, reservados: [] };
    renderPublic(); renderSheet();
  };
  $("#orgLogin").onclick = entrarOrganizador;
}

/* ---------- Finalizar pedido ---------- */
function buildMsg(lista) {
  const q = lista.length;
  const t = sheet.modo === "fralda"
    ? `1 pacote de fralda${sheet.tamanho ? ` (tamanho ${sheet.tamanho})` : ""} + 1 mimo por número${q > 1 ? ` — total: ${q} pacotes + ${q} mimos` : ""}`
    : `Pix de ${money(sheet.valor)} por número — total ${money(sheet.valor * q)}`;
  return `Olá! Reservei ${q > 1 ? "números" : "um número"} na ${config.titulo} 💕\n\nNome: ${sheet.nome.trim() || "(meu nome)"}\nTelefone: ${sheet.telefone ? fmtTel(sheet.telefone) : "(meu telefone)"}\nNúmero${q > 1 ? "s" : ""}: ${lista.map(pad).join(", ")}\nForma: ${t}` +
    (sheet.modo === "pix" ? "\n\nSegue o comprovante do Pix." : "") + "\n\nObrigado!";
}

function closeSheet() {
  const bg = $("#sheetbg"); if (bg) bg.remove();
  sheet = null; renderPublic();
}

function pixBox(q) {
  return `<div class="pixbox"><span class="lbl">Chave Pix${config.nomePix ? " · " + esc(config.nomePix) : ""}</span>` +
    (config.chavePix
      ? `<div class="pixkey"><code id="pixk">${esc(config.chavePix)}</code><button class="btn btn-primary btn-sm" id="cpix">Copiar</button></div>`
      : '<p class="note" style="margin:6px 0 0">A família vai te passar a chave Pix pelo WhatsApp.</p>') +
    `</div><div class="total"><span>Total do Pix</span><b class="tnum" id="tot">${money((Number(sheet.valor) || 0) * q)}</b></div>`;
}

function renderSheet() {
  const old = $("#sheetbg"); if (old) old.remove();
  if (!sheet) return;
  const min = Number(config.pixMinimo) || 0, wa = waNumber();
  let h = '<div class="sheet-bg" id="sheetbg"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sht">';

  if (sheet.stage === "done") {
    const lista = sheet.reservados, msg = buildMsg(lista);
    h += `<div class="done-ico">${checkSvg}</div>
      <h2 id="sht">Números reservados!</h2>
      <p class="sub">Os números <b class="tnum">${lista.map(pad).join(", ")}</b> já aparecem como reservados para todo mundo. Agora envie a mensagem para a família${sheet.modo === "pix" ? " e faça o Pix" : ""}.</p>
      ${sheet.modo === "pix" ? pixBox(lista.length) : ""}
      <span class="lbl">Mensagem</span><pre class="msg" id="msg" style="margin-top:6px">${esc(msg)}</pre>
      <div class="row">${wa ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/${wa}?text=${encodeURIComponent(msg)}">Enviar pelo WhatsApp</a>` : ""}
        <button class="btn ${wa ? "btn-soft" : "btn-primary"}" id="cmsg">Copiar mensagem</button></div>
      <p class="note">A reserva vira confirmada quando a família receber sua contribuição. Reservas sem retorno podem ser liberadas para outras pessoas.</p>
      <div class="row" style="margin-top:10px"><button class="btn btn-ghost" id="fechar">Fechar</button></div>`;
  } else {
    const q = sel.length, valOk = Number(sheet.valor) >= min;
    h += `<h2 id="sht">Seus números: <span class="tnum">${sel.map(pad).join(", ")}</span></h2>
      <p class="sub">Falta pouco! Diga quem é você e como quer contribuir.</p>
      <div class="field"><label for="f-nome">Seu nome</label><input class="inp" id="f-nome" autocomplete="name" maxlength="60" value="${esc(sheet.nome)}" placeholder="Ex.: Maria Souza"></div>
      <div class="field"><label for="f-tel">Telefone / WhatsApp</label><input class="inp tnum" id="f-tel" type="tel" inputmode="numeric" autocomplete="tel-national" value="${esc(maskTel(sheet.telefone))}" placeholder="(13) 99999-9999">
        <span class="hint">Só a família vê seu telefone. Ele serve para te encontrar se houver algum problema com a reserva.</span>
        <span class="err" id="telerr" hidden>Digite o telefone com DDD.</span></div>
      <span class="lbl">Forma de contribuição</span><div class="opts" style="margin-top:6px">
        <button class="opt" data-m="fralda" aria-pressed="${sheet.modo === "fralda"}"><b>Fralda + mimo</b><span>${q} pacote${q > 1 ? "s" : ""} + ${q} mimo${q > 1 ? "s" : ""}</span></button>
        <button class="opt" data-m="pix" aria-pressed="${sheet.modo === "pix"}"><b>Pix</b><span>A partir de ${money(min)} por número</span></button>
      </div>`;
    if (sheet.modo === "fralda") {
      const sz = sizes();
      h += `<div class="field"><label for="f-tam">Tamanho da fralda</label>${sz.length
        ? `<select class="inp" id="f-tam">${sz.map((z) => `<option${z === sheet.tamanho ? " selected" : ""}>${esc(z)}</option>`).join("")}</select>`
        : `<input class="inp" id="f-tam" maxlength="10" value="${esc(sheet.tamanho)}">`}<span class="hint">O mimo é livre: um brinquedo, roupinha, lencinhos, pomada…</span></div>`;
    } else {
      h += `<div class="field"><label for="f-val">Valor por número (R$)</label><input class="inp tnum" id="f-val" type="number" inputmode="decimal" min="${min}" step="1" value="${esc(sheet.valor)}">
        <span class="err" id="valerr"${valOk ? " hidden" : ""}>O valor mínimo é ${money(min)} por número.</span></div>` + pixBox(q);
    }
    h += `<span class="lbl">Mensagem que será enviada</span><pre class="msg" id="msg" style="margin-top:6px">${esc(buildMsg(sel))}</pre>
      <div class="row"><button class="btn btn-primary" id="reservar">Reservar número${q > 1 ? "s" : ""}</button></div>
      <p class="note">Ao reservar, os números ficam guardados para você na hora e aparecem como reservados para todos.</p>
      <div class="row" style="margin-top:10px"><button class="btn btn-ghost" id="back">Voltar e mudar números</button></div>`;
  }
  h += "</div></div>";
  document.body.insertAdjacentHTML("beforeend", h);

  const bg = $("#sheetbg");
  bg.addEventListener("click", (e) => { if (e.target === bg && !busy) closeSheet(); });
  const cpix = $("#cpix"); if (cpix) cpix.onclick = () => copy(config.chavePix, $("#pixk"));
  const cmsg = $("#cmsg"); if (cmsg) cmsg.onclick = () => copy($("#msg").textContent, $("#msg"));

  if (sheet.stage === "done") { $("#fechar").onclick = closeSheet; return; }

  $("#back").onclick = closeSheet;
  $$(".opt", bg).forEach((b) => { b.onclick = () => { sheet.modo = b.dataset.m; renderSheet(); }; });
  const refresh = () => {
    $("#msg").textContent = buildMsg(sel);
    const t = $("#tot"); if (t) t.textContent = money((Number(sheet.valor) || 0) * sel.length);
    const e = $("#valerr"); if (e) e.hidden = Number(sheet.valor) >= min;
  };
  $("#f-nome").oninput = (e) => { sheet.nome = e.target.value; refresh(); };
  const ftel = $("#f-tel");
  ftel.oninput = (e) => {
    const m = maskTel(e.target.value); e.target.value = m; sheet.telefone = digits(m);
    if (telOk(sheet.telefone)) $("#telerr").hidden = true;
    refresh();
  };
  ftel.onblur = () => { $("#telerr").hidden = !sheet.telefone || telOk(sheet.telefone); };
  const ft = $("#f-tam"); if (ft) ft.oninput = ft.onchange = (e) => { sheet.tamanho = e.target.value; refresh(); };
  const fv = $("#f-val"); if (fv) fv.oninput = (e) => { sheet.valor = e.target.value; refresh(); };
  $("#reservar").onclick = reservar;
}

async function reservar() {
  if (busy) return;
  const nome = sheet.nome.trim(), min = Number(config.pixMinimo) || 0;
  if (nome.length < 2) { toast("Digite seu nome."); $("#f-nome").focus(); return; }
  const telefone = digits(sheet.telefone);
  if (!telOk(telefone)) { $("#telerr").hidden = false; toast("Digite seu telefone com DDD."); $("#f-tel").focus(); return; }
  if (sheet.modo === "pix" && !(Number(sheet.valor) >= min)) { toast(`O valor mínimo é ${money(min)} por número.`); return; }
  if (!sel.length) return;

  busy = true;
  const btn = $("#reservar"); btn.disabled = true; btn.textContent = "Reservando…";
  const lista = sel.slice();
  const pedido = novoPedido();
  try {
    await runTransaction(db, async (tx) => {
      const refs = lista.map((n) => doc(db, "numeros", String(n)));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const ocupados = snaps.filter((s) => s.exists()).map((s) => +s.id);
      if (ocupados.length) { const err = new Error("ocupado"); err.ocupados = ocupados; throw err; }
      // Contato fica numa coleção separada, que só o organizador pode ler
      tx.set(doc(db, "contatos", pedido), {
        nome, telefone, numeros: lista, modo: sheet.modo,
        valor: sheet.modo === "pix" ? Number(sheet.valor) : null,
        t: serverTimestamp()
      });
      refs.forEach((r) => tx.set(r, {
        s: "reservado", nome, modo: sheet.modo,
        tamanho: sheet.modo === "fralda" ? String(sheet.tamanho || "").slice(0, 10) : "",
        valor: sheet.modo === "pix" ? Number(sheet.valor) : null,
        t: serverTimestamp(), origem: "site", pedido
      }));
    });
    try { localStorage.setItem("rifa-contato", JSON.stringify({ nome, telefone })); } catch { /* sem armazenamento */ }
    sheet.stage = "done"; sheet.reservados = lista; sel = [];
    busy = false; renderPublic(); renderSheet();
  } catch (e) {
    busy = false;
    if (e.ocupados) {
      sel = sel.filter((n) => !e.ocupados.includes(n));
      toast(`O${e.ocupados.length > 1 ? "s números" : " número"} ${e.ocupados.map(pad).join(", ")} acabou de ser reservado por outra pessoa.`);
      if (sel.length) renderSheet(); else closeSheet();
    } else if (e.code === "permission-denied") {
      toast("Não foi possível reservar. As escolhas podem ter sido encerradas; recarregue a página.");
      renderSheet();
    } else {
      toast("Falha de conexão. Confira a internet e tente de novo.");
      renderSheet();
    }
  }
}

/* =========================================================
   Painel do organizador
   ========================================================= */
const stat = (l, v) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`;
const tab = (t, l) => `<button class="tab" role="tab" data-t="${t}" aria-selected="${adminTab === t}">${l}</button>`;
function statsHtml() {
  const c = counts();
  return stat("Disponíveis", c.livre) + stat("Reservados", c.res) + stat("Confirmados", c.pag) + stat("Fraldas + mimos", c.fraldas) + stat("Pix confirmado", money(c.pix));
}

function renderAdmin() {
  $("#app").innerHTML = `<div class="wrap admin">${topbar()}
    <div class="adm-head"><div><h1>Painel do organizador</h1>
      <p class="userbox" style="margin:4px 0 0">Conectado como ${esc(authUser && authUser.email)} · <button class="linkbtn" id="sair" style="min-height:0;padding:0">Sair</button></p></div>
      <button class="btn btn-ghost btn-sm" id="csv">Exportar planilha (CSV)</button></div>
    <p style="margin:8px 0 0;color:var(--muted)">Tudo o que você altera aqui aparece na hora para os participantes.</p>
    <div class="stats" id="stats">${statsHtml()}</div>
    <div class="tabs" role="tablist">${tab("numeros", "Números")}${tab("pessoas", "Participantes")}${tab("config", "Configurações")}${tab("sorteio", "Sorteio")}</div>
    <div class="panel" id="panel"></div></div>`;
  bindTop();
  $$(".tab").forEach((b) => { b.onclick = () => { adminTab = b.dataset.t; cfgDraft = null; renderAdmin(); }; });
  $("#csv").onclick = exportCsv;
  $("#sair").onclick = async () => { await signOut(auth); view = "public"; render(); };
  ({ numeros: panelNumeros, pessoas: panelPessoas, config: panelConfig, sorteio: panelSorteio })[adminTab]();
}

// Chamado quando chegam dados novos: atualiza sem apagar o que está sendo digitado.
function refreshAdmin() {
  if (!$("#panel")) { renderAdmin(); return; }
  $("#stats").innerHTML = statsHtml();
  if (adminTab === "numeros") { drawAdminGrid(); }
  else if (adminTab === "pessoas") panelPessoas();
  else if (adminTab === "sorteio" && !spinning) panelSorteio();
}

/* ---------- Números ---------- */
const achip = (v, l) => chip(v, l, admFilter, "data-af");
function panelNumeros() {
  $("#panel").innerHTML = `<div class="adm-tools"><div class="chips" role="group" aria-label="Filtro">${achip("todos", "Todos")}${achip("livres", "Disponíveis")}${achip("res", "Reservados")}${achip("pag", "Confirmados")}</div>
    <input class="inp" id="aq" type="search" placeholder="Buscar por nome ou número" value="${esc(admQuery)}" aria-label="Buscar"></div>
    <div class="split"><div><p style="margin:0 0 10px;color:var(--muted);font-size:14px">Toque em um ou mais números para editar. O pontinho indica reserva feita pelo site.</p>
      <div class="grid" id="agrid"></div><p class="empty" id="agrid-empty" hidden>Nenhum número encontrado.</p></div>
      <div class="card editor" id="editor"></div></div>`;
  $("#aq").oninput = (e) => { admQuery = e.target.value; drawAdminGrid(); };
  $$(".chip[data-af]").forEach((b) => { b.onclick = () => { admFilter = b.dataset.af; $$(".chip[data-af]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); drawAdminGrid(); }; });
  $("#agrid").addEventListener("click", (e) => {
    const b = e.target.closest(".num"); if (!b) return;
    const i = +b.dataset.n, k = asel.indexOf(i);
    if (k >= 0) asel.splice(k, 1); else { asel.push(i); asel.sort((a, b) => a - b); }
    b.classList.toggle("sel", k < 0); b.setAttribute("aria-pressed", String(k < 0));
    renderEditor();
  });
  drawAdminGrid();
  renderEditor();
}

function drawAdminGrid() {
  const g = $("#agrid"); if (!g) return;
  const q = admQuery.trim().toLowerCase();
  let h = "", shown = 0;
  for (let i = 1; i <= total(); i++) {
    const n = numeros[i];
    if (admFilter === "livres" && n) continue;
    if (admFilter === "res" && !(n && n.s !== "pago")) continue;
    if (admFilter === "pag" && !(n && n.s === "pago")) continue;
    if (q && !(String(i).includes(q) || pad(i).includes(q) || (n && String(n.nome || "").toLowerCase().includes(q)))) continue;
    shown++;
    const cls = "num" + (n ? (n.s === "pago" ? " pag" : " res") : "") + (asel.includes(i) ? " sel" : "");
    h += `<button class="${cls}" data-n="${i}" aria-pressed="${asel.includes(i)}" title="${esc((n && n.nome) || "Disponível")}">${n && n.origem === "site" ? '<span class="dot-site"></span>' : ""}${pad(i)}${n && n.nome ? `<small>${esc(n.nome.split(" ")[0])}</small>` : ""}</button>`;
  }
  g.innerHTML = h;
  $("#agrid-empty").hidden = shown > 0;
}

function renderEditor() {
  const box = $("#editor"); if (!box) return;
  if (!asel.length) {
    ed = null;
    box.innerHTML = '<h3>Editar números</h3><p class="sub">Nenhum número selecionado.</p><p class="empty" style="padding:10px 0">Selecione números na grade para reservar, confirmar pagamento ou liberar.</p>';
    return;
  }
  const first = numeros[asel[0]] || {};
  const ct = contatoDe(first);
  ed = {
    s: first.s || "reservado", nome: first.nome || "", telefone: ct ? ct.telefone : "", modo: first.modo || "fralda",
    tamanho: first.tamanho || "", valor: first.valor != null ? first.valor : config.pixMinimo, obs: first.obs || ""
  };
  const anyTaken = asel.some((i) => numeros[i]);

  const draw = () => {
    box.innerHTML = `<h3>${asel.length} número${asel.length > 1 ? "s" : ""} selecionado${asel.length > 1 ? "s" : ""}</h3><p class="sub tnum">${asel.map(pad).join(", ")}</p>
      <span class="lbl">Situação</span><div class="seg two" style="margin-top:6px">
        <button data-es="reservado" aria-pressed="${ed.s === "reservado"}">Reservado</button><button data-es="pago" aria-pressed="${ed.s === "pago"}">Confirmado</button></div>
      <div class="field"><label for="e-nome">Nome do participante</label><input class="inp" id="e-nome" maxlength="60" value="${esc(ed.nome)}"></div>
      <div class="field"><label for="e-tel">Telefone</label><input class="inp tnum" id="e-tel" type="tel" inputmode="numeric" value="${esc(maskTel(ed.telefone))}" placeholder="(13) 99999-9999">${ed.telefone && telOk(ed.telefone) ? `<span class="hint"><a href="https://wa.me/55${digits(ed.telefone)}" target="_blank" rel="noopener">Abrir conversa no WhatsApp</a></span>` : ""}</div>
      <span class="lbl">Forma</span><div class="seg two" style="margin-top:6px"><button data-em="fralda" aria-pressed="${ed.modo === "fralda"}">Fralda + mimo</button><button data-em="pix" aria-pressed="${ed.modo === "pix"}">Pix</button></div>
      ${ed.modo === "fralda"
        ? `<div class="field"><label for="e-tam">Tamanho da fralda</label><input class="inp" id="e-tam" list="tams" maxlength="10" value="${esc(ed.tamanho)}"><datalist id="tams">${sizes().map((z) => `<option value="${esc(z)}">`).join("")}</datalist></div>`
        : `<div class="field"><label for="e-val">Valor Pix por número (R$)</label><input class="inp tnum" id="e-val" type="number" min="0" step="1" value="${esc(ed.valor)}"><span class="hint">Mínimo definido: ${money(config.pixMinimo)}</span></div>`}
      <div class="field"><label for="e-obs">Observação (opcional)</label><input class="inp" id="e-obs" maxlength="120" value="${esc(ed.obs)}" placeholder="Ex.: entregou no dia 12"></div>
      <div class="row"><button class="btn btn-primary" id="apply">Aplicar</button>${anyTaken ? '<button class="btn btn-danger" id="free">Liberar</button>' : ""}</div>
      <p class="note"><button class="btn btn-ghost btn-sm" id="desel">Limpar seleção</button></p>
      <p class="note">Os nomes ficam visíveis para quem abre a página (a grade mostra só o primeiro nome). Não coloque telefone nas observações.</p>`;
    $$("[data-es]", box).forEach((b) => { b.onclick = () => { ed.s = b.dataset.es; draw(); }; });
    $$("[data-em]", box).forEach((b) => { b.onclick = () => { ed.modo = b.dataset.em; draw(); }; });
    $("#e-nome").oninput = (e) => { ed.nome = e.target.value; };
    $("#e-tel").oninput = (e) => { const m = maskTel(e.target.value); e.target.value = m; ed.telefone = digits(m); };
    const et = $("#e-tam"); if (et) et.oninput = (e) => { ed.tamanho = e.target.value; };
    const ev = $("#e-val"); if (ev) ev.oninput = (e) => { ed.valor = e.target.value; };
    $("#e-obs").oninput = (e) => { ed.obs = e.target.value; };
    $("#apply").onclick = aplicarEdicao;
    const fr = $("#free");
    if (fr) fr.onclick = () => {
      if (fr.dataset.c !== "1") { fr.dataset.c = "1"; fr.textContent = "Toque de novo para liberar"; return; }
      liberar(asel.slice());
    };
    $("#desel").onclick = () => { asel = []; drawAdminGrid(); renderEditor(); };
  };
  draw();
}

async function aplicarEdicao() {
  if (!ed.nome.trim()) { toast("Informe o nome do participante."); $("#e-nome").focus(); return; }
  if (ed.telefone && !telOk(ed.telefone)) { toast("Telefone incompleto. Use DDD + número, ou deixe em branco."); $("#e-tel").focus(); return; }
  const b = writeBatch(db);
  // Reaproveita o pedido existente dos números selecionados, ou cria um novo
  const pedido = (asel.map((i) => numeros[i] && numeros[i].pedido).find(Boolean)) || novoPedido();
  b.set(doc(db, "contatos", pedido), {
    nome: ed.nome.trim(), telefone: digits(ed.telefone), numeros: arrayUnion(...asel),
    modo: ed.modo, valor: ed.modo === "pix" ? Number(ed.valor) || 0 : null, t: serverTimestamp()
  }, { merge: true });
  asel.forEach((i) => {
    const old = numeros[i] || {};
    // Número que estava em outro pedido sai da lista daquele contato
    if (old.pedido && old.pedido !== pedido && contatos[old.pedido]) b.update(doc(db, "contatos", old.pedido), { numeros: arrayRemove(i) });
    b.set(doc(db, "numeros", String(i)), {
      s: ed.s, nome: ed.nome.trim(), modo: ed.modo,
      tamanho: ed.modo === "fralda" ? String(ed.tamanho || "").trim() : "",
      valor: ed.modo === "pix" ? Number(ed.valor) || 0 : null,
      obs: String(ed.obs || "").trim(), t: serverTimestamp(),
      origem: old.origem || "admin", pedido
    });
  });
  try {
    await b.commit();
    toast(`${asel.length} número${asel.length > 1 ? "s" : ""} atualizado${asel.length > 1 ? "s" : ""}.`);
    asel = []; drawAdminGrid(); renderEditor();
  } catch (e) { toast("Não foi possível salvar. Confira a internet e se você está conectado."); console.error(e); }
}

async function liberar(lista) {
  const b = writeBatch(db);
  lista.forEach((i) => {
    const p = numeros[i] && numeros[i].pedido;
    if (p && contatos[p]) b.update(doc(db, "contatos", p), { numeros: arrayRemove(i) });
    b.delete(doc(db, "numeros", String(i)));
  });
  try {
    await b.commit();
    toast(`${lista.length} número${lista.length > 1 ? "s liberados" : " liberado"}.`);
    asel = asel.filter((n) => !lista.includes(n));
    if (adminTab === "numeros") { drawAdminGrid(); renderEditor(); }
  } catch (e) { toast("Não foi possível liberar agora."); console.error(e); }
}

async function confirmar(lista) {
  const b = writeBatch(db);
  lista.forEach((i) => b.update(doc(db, "numeros", String(i)), { s: "pago", t: serverTimestamp() }));
  try { await b.commit(); toast("Números confirmados."); }
  catch (e) { toast("Não foi possível confirmar agora."); console.error(e); }
}

/* ---------- Participantes ---------- */
function grupos() {
  const g = {};
  for (let i = 1; i <= total(); i++) {
    const n = numeros[i]; if (!n) continue;
    const ct = contatoDe(n), tel = ct ? digits(ct.telefone) : "";
    // Agrupa pelo telefone quando existe (mesma pessoa com nomes escritos diferente)
    const k = tel ? "t:" + tel : "n:" + String(n.nome || "(sem nome)").trim().toLowerCase();
    if (!g[k]) g[k] = { nome: n.nome || "(sem nome)", nomes: new Set(), telefone: tel, pedidos: new Set(), nums: [], pag: 0, res: 0, fr: 0, pix: 0, tams: new Set(), site: false, ultimo: 0 };
    const x = g[k];
    x.nomes.add(String(n.nome || "").trim());
    if (n.pedido) x.pedidos.add(n.pedido);
    x.nums.push(i);
    if (n.s === "pago") x.pag++; else x.res++;
    if (n.modo === "pix") x.pix += Number(n.valor) || 0; else { x.fr++; if (n.tamanho) x.tams.add(n.tamanho); }
    if (n.origem === "site" && n.s !== "pago") x.site = true;
    const d = tsDate(n.t); if (d) x.ultimo = Math.max(x.ultimo, d.getTime());
  }
  // Pedidos aguardando confirmação primeiro, depois os mais recentes
  return Object.values(g).sort((a, b) => (b.res > 0) - (a.res > 0) || b.ultimo - a.ultimo);
}

function panelPessoas() {
  const g = grupos();
  if (!g.length) { $("#panel").innerHTML = '<div class="card empty">Ainda não há participantes. As reservas feitas pelo site aparecem aqui na hora.</div>'; return; }
  // Nomes iguais com telefones diferentes podem ser pessoas diferentes ou erro de digitação
  const porNome = {};
  g.forEach((x) => { const k = x.nome.trim().toLowerCase(); porNome[k] = (porNome[k] || 0) + 1; });
  let h = '<div class="tablewrap"><table><thead><tr><th>Participante</th><th>Telefone</th><th>Números</th><th>Contribuição</th><th>Situação</th><th>Ações</th></tr></thead><tbody>';
  g.forEach((x, idx) => {
    const contrib = [];
    if (x.fr) contrib.push(`${x.fr} fralda${x.fr > 1 ? "s" : ""} + mimo${x.fr > 1 ? "s" : ""}${x.tams.size ? ` (${[...x.tams].join(", ")})` : ""}`);
    if (x.pix) contrib.push("Pix " + money(x.pix));
    const quando = x.ultimo ? new Date(x.ultimo).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    h += `<tr class="click" data-g="${idx}" tabindex="0">
      <td><b>${esc(x.nome)}</b>${x.nomes.size > 1 ? `<br><span style="font-size:12px;color:var(--muted)">também como: ${esc([...x.nomes].filter((v) => v && v !== x.nome).join(", "))}</span>` : ""}${quando ? `<br><span style="font-size:12px;color:var(--muted)">${quando}</span>` : ""}
        ${x.pedidos.size > 1 ? `<br><span class="pill res">${x.pedidos.size} pedidos</span>` : ""}${porNome[x.nome.trim().toLowerCase()] > 1 ? ' <span class="pill res">nome repetido</span>' : ""}</td>
      <td class="tnum">${x.telefone ? `<a href="https://wa.me/55${x.telefone}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(fmtTel(x.telefone))}</a>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="tnum">${x.nums.map(pad).join(", ")}</td>
      <td>${esc(contrib.join(" · ") || "-")}</td>
      <td>${x.pag ? `<span class="pill pag">${x.pag} confirmado${x.pag > 1 ? "s" : ""}</span> ` : ""}${x.res ? `<span class="pill res">${x.res} reservado${x.res > 1 ? "s" : ""}</span> ` : ""}${x.site ? '<span class="pill site">pelo site</span>' : ""}</td>
      <td><div class="acts-sm">${x.res ? `<button class="btn btn-soft" data-conf="${idx}">Confirmar</button>` : ""}<button class="btn btn-danger" data-lib="${idx}">Liberar</button></div></td></tr>`;
  });
  h += '</tbody></table></div><p class="note">Toque em um participante para editar os números dele. "Confirmar" marca como pago tudo o que está reservado para essa pessoa. Pessoas com o mesmo telefone aparecem juntas; os avisos "nome repetido" e "pedidos" ajudam a achar duplicidades.</p>';
  $("#panel").innerHTML = h;
  $$("tr[data-g]").forEach((r) => {
    const open = () => { asel = g[+r.dataset.g].nums.slice(); adminTab = "numeros"; admFilter = "todos"; admQuery = ""; renderAdmin(); };
    r.onclick = open;
    r.onkeydown = (e) => { if (e.key === "Enter") open(); };
  });
  $$("[data-conf]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const x = g[+b.dataset.conf]; confirmar(x.nums.filter((n) => numeros[n] && numeros[n].s !== "pago")); }; });
  $$("[data-lib]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      if (b.dataset.c !== "1") { b.dataset.c = "1"; b.textContent = "Tem certeza?"; return; }
      liberar(g[+b.dataset.lib].nums);
    };
  });
}

/* ---------- Configurações ---------- */
function fld(k, l, v, cls = "", hint = "") {
  return `<div class="field ${cls}"><label for="c-${k}">${l}</label><input class="inp" id="c-${k}" data-k="${k}" value="${esc(v)}">${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
}
function panelConfig() {
  cfgDraft = { ...config };
  const c = cfgDraft;
  const maxTaken = Math.max(0, ...Object.keys(numeros).map(Number));
  $("#panel").innerHTML = `<div class="card">
    <div class="sect"><h3>Rifa</h3><div class="form2">
      ${fld("titulo", "Nome da rifa", c.titulo)}${fld("premio", "Prêmio", c.premio)}
      ${fld("subtitulo", "Frase do prêmio", c.subtitulo, "full")}${fld("mensagem", "Frase de agradecimento", c.mensagem, "full")}
      <div class="field"><label for="c-dataSorteio">Data do sorteio</label><input class="inp" type="date" id="c-dataSorteio" data-k="dataSorteio" value="${esc(c.dataSorteio)}"></div>
      <div class="field"><label for="c-totalNumeros">Quantidade de números</label><input class="inp tnum" type="number" min="${Math.max(1, maxTaken)}" max="1000" id="c-totalNumeros" data-k="totalNumeros" value="${esc(c.totalNumeros)}">
        <span class="hint">${maxTaken ? `Não pode ser menor que ${maxTaken} (maior número já escolhido).` : "Padrão: 200."}</span></div>
      <div class="field full"><label for="c-comoSorteio">Como será o sorteio</label><textarea class="inp" id="c-comoSorteio" data-k="comoSorteio">${esc(c.comoSorteio)}</textarea></div>
      <div class="field full"><label class="toggle"><input type="checkbox" id="c-aceitandoPedidos" data-k="aceitandoPedidos"${c.aceitandoPedidos ? " checked" : ""}> Aceitando novas reservas pelo site</label><span class="hint">Desmarque para encerrar as vendas antes do sorteio.</span></div>
    </div></div>
    <div class="sect"><h3>Contribuição</h3><div class="form2">
      <div class="field"><label for="c-pixMinimo">Pix mínimo por número (R$)</label><input class="inp tnum" type="number" min="0" step="1" id="c-pixMinimo" data-k="pixMinimo" value="${esc(c.pixMinimo)}"></div>
      ${fld("tamanhos", "Tamanhos de fralda aceitos", c.tamanhos, "", "Separe por vírgula. Ex.: RN, P, M, G")}
      ${fld("chavePix", "Chave Pix", c.chavePix, "", "Aparece para quem escolher Pix.")}${fld("nomePix", "Nome de quem recebe o Pix", c.nomePix)}
      ${fld("whatsapp", "WhatsApp para receber os pedidos", c.whatsapp, "", "Com DDD. Ex.: 13 99999-9999")}
    </div></div>
    <p class="note">Para trocar o banner, substitua o arquivo <code>banner.jpg</code> no repositório.</p>
    <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="saveCfg">Salvar configurações</button></div>
  </div>`;
  $$("[data-k]").forEach((el) => {
    el.oninput = el.onchange = () => {
      const k = el.dataset.k;
      let v = el.type === "checkbox" ? el.checked : el.value;
      if (k === "totalNumeros" || k === "pixMinimo") v = Number(v);
      cfgDraft[k] = v;
    };
  });
  $("#saveCfg").onclick = async () => {
    const t = Math.round(Number(cfgDraft.totalNumeros));
    if (!(t >= Math.max(1, maxTaken) && t <= 1000)) { toast(`A quantidade de números precisa ficar entre ${Math.max(1, maxTaken)} e 1000.`); return; }
    if (!(Number(cfgDraft.pixMinimo) >= 0)) { toast("Informe um Pix mínimo válido."); return; }
    cfgDraft.totalNumeros = t;
    const btn = $("#saveCfg"); btn.disabled = true; btn.textContent = "Salvando…";
    try { await setDoc(doc(db, "rifa", "config"), { config: cfgDraft }, { merge: true }); toast("Configurações salvas."); }
    catch (e) { toast("Não foi possível salvar as configurações."); console.error(e); }
    btn.disabled = false; btn.textContent = "Salvar configurações";
  };
}

/* ---------- Sorteio ---------- */
function panelSorteio() {
  const pool = [], T = total(); let res = 0;
  for (let i = 1; i <= T; i++) { const n = numeros[i]; if (!n) continue; if (n.s === "pago") pool.push(i); else res++; }
  const w = sorteio && sorteio.numero, show = drawn || w;
  $("#panel").innerHTML = `<div class="draw">
    <div class="card center"><h3 class="fd" style="font-size:20px;color:var(--berry)">Sortear agora</h3>
      <p style="color:var(--muted);margin:6px 0 0">Sorteia entre os <b>${pool.length}</b> números confirmados.</p>
      ${res ? `<p class="warn" style="margin-top:10px">${res} número${res > 1 ? "s estão" : " está"} só reservado${res > 1 ? "s" : ""} e fica${res > 1 ? "m" : ""} de fora. Confirme antes de sortear, se for o caso.</p>` : ""}
      <div class="drawball tnum${show ? "" : " idle"}" id="ball">${show ? pad(show) : "?"}</div>
      ${show && numeros[show] ? `<p style="margin:0 0 12px"><b>${esc(numeros[show].nome)}</b></p>` : ""}
      <div class="row"><button class="btn btn-primary" id="dr"${pool.length ? "" : " disabled"}>${drawn ? "Sortear de novo" : "Sortear"}</button>${drawn && drawn !== w ? '<button class="btn btn-soft" id="reg">Registrar ganhador</button>' : ""}</div></div>
    <div class="card"><h3 class="fd" style="font-size:20px;color:var(--berry)">Resultado oficial</h3>
      ${w ? `<p>Ganhador registrado: <b class="tnum">${pad(w)}</b>${numeros[w] ? " · " + esc(numeros[w].nome) : ""}</p><p class="note">O resultado já aparece no topo da página dos participantes.</p><button class="btn btn-danger btn-sm" id="clrw">Remover resultado</button>`
        : '<p style="color:var(--muted)">Nenhum ganhador registrado ainda.</p>'}
      <div class="field" style="margin-top:16px"><label for="mw">Registrar número manualmente</label>
        <div class="row"><input class="inp tnum" id="mw" type="number" min="1" max="${T}" placeholder="Ex.: 87" style="flex:1 1 120px"><button class="btn btn-soft" id="mwb" style="flex:0 0 auto">Registrar</button></div>
        <span class="hint">Use se o sorteio for feito por fora (ex.: Loteria Federal).</span></div></div></div>`;

  const dr = $("#dr");
  if (dr) dr.onclick = () => {
    const ball = $("#ball"); let k = 0; dr.disabled = true; spinning = true; ball.classList.remove("idle");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rnd = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return pool[a[0] % pool.length]; };
    const it = setInterval(() => {
      ball.textContent = pad(rnd());
      if (++k > (reduce ? 1 : 18)) { clearInterval(it); drawn = rnd(); spinning = false; panelSorteio(); }
    }, 70);
  };
  const reg = $("#reg"); if (reg) reg.onclick = () => salvarGanhador(drawn);
  const clrw = $("#clrw"); if (clrw) clrw.onclick = () => salvarGanhador(null);
  $("#mwb").onclick = () => {
    const v = parseInt($("#mw").value, 10);
    if (!v || v < 1 || v > T) { toast(`Digite um número entre 1 e ${T}.`); return; }
    salvarGanhador(v);
  };
}

async function salvarGanhador(n) {
  const d = new Date();
  const data = n ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
  try {
    await setDoc(doc(db, "rifa", "config"), { sorteio: { numero: n, data } }, { merge: true });
    drawn = null;
    toast(n ? "Ganhador registrado e publicado." : "Resultado removido.");
  } catch (e) { toast("Não foi possível salvar o resultado."); console.error(e); }
}

/* ---------- Exportar CSV ---------- */
function exportCsv() {
  const rows = [["Número", "Situação", "Nome", "Telefone", "Forma", "Tamanho fralda", "Valor Pix", "Observação", "Origem", "Atualizado em"]];
  for (let i = 1; i <= total(); i++) {
    const n = numeros[i] || {}, d = tsDate(n.t);
    const ct = contatoDe(n);
    rows.push([pad(i), n.s ? (n.s === "pago" ? "Confirmado" : "Reservado") : "Disponível", n.nome || "", ct && ct.telefone ? fmtTel(ct.telefone) : "",
      n.s ? (n.modo === "pix" ? "Pix" : "Fralda + mimo") : "", n.tamanho || "",
      n.modo === "pix" ? String(n.valor || 0).replace(".", ",") : "", n.obs || "",
      n.origem === "site" ? "Site" : n.s ? "Painel" : "", d ? d.toLocaleString("pt-BR") : ""]);
  }
  const csv = "﻿" + rows.map((r) => r.map((v) => { v = String(v); return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = "rifa-laurinha.csv";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
