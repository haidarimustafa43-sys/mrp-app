"use strict";

/* =====================================================================
   Partiformningsmetoder
   Nya metoder läggs till här och dyker då automatiskt upp i dropdown-
   menyn under Artikeldata. calculate() får ett kontextobjekt och ska
   returnera { quantity, explanation }.
   "requirement" är det som fattas för att nå säkerhetslagret.
   ===================================================================== */

const LOT_METHODS = {
    LFL: {
        label: "LFL – behov mot behov",
        valueLabel: null,
        defaultValue: 1,
        calculate: ({ requirement }) => ({
            quantity: requirement,
            explanation:
                `LFL: beställ exakt det som fattas = ${fmt(requirement)}.`
        })
    },

    FOQ: {
        label: "FOQ – fast orderkvantitet",
        valueLabel: "Orderkvantitet",
        defaultValue: 100,
        calculate: ({ requirement, lotValue }) => {
            const batches = Math.ceil(requirement / lotValue);
            const quantity = batches * lotValue;

            return {
                quantity,
                explanation: batches === 1
                    ? `FOQ: en order på ${fmt(lotValue)} täcker behovet ${fmt(requirement)}.`
                    : `FOQ: ${batches} × ${fmt(lotValue)} = ${fmt(quantity)} behövs för att täcka behovet ${fmt(requirement)}.`
            };
        }
    },

    POQ: {
        label: "POQ – periodiskt behov",
        valueLabel: "Antal perioder",
        defaultValue: 2,
        calculate: ({
            requirement,
            lotValue,
            periodIndex,
            grossRequirements,
            availableBeforeDemand,
            safetyStock
        }) => {
            const lastIndex = Math.min(
                grossRequirements.length,
                periodIndex + lotValue
            ) - 1;

            let coveredDemand = 0;

            for (let p = periodIndex; p <= lastIndex; p++) {
                coveredDemand += grossRequirements[p];
            }

            const quantity = Math.max(
                requirement,
                coveredDemand - availableBeforeDemand + safetyStock
            );

            const range = lastIndex > periodIndex
                ? `perioderna ${periodIndex + 1}–${lastIndex + 1}`
                : `period ${periodIndex + 1}`;

            return {
                quantity,
                explanation:
                    `POQ (${lotValue} perioder): bruttobehov för ${range} = ${fmt(coveredDemand)}. ` +
                    `Order = ${fmt(coveredDemand)} − ${par(availableBeforeDemand)} + säkerhetslager ${fmt(safetyStock)} = ${fmt(quantity)}.`
            };
        }
    }
};

/* =====================================================================
   Tillstånd
   ===================================================================== */

const state = {
    periods: 8,
    source: "forecast",      // "forecast" = huvudplanen beräknas, "mps" = huvudplanen är given
    forecast: Array(8).fill(0),
    mps: Array(8).fill(0),   // given huvudplan: MPS start per period
    articles: [],
    bom: [],
    rootId: null
};

const ui = {
    addingTo: null,          // path-nyckel för noden som har ett öppet "lägg till"-formulär
    dirty: true,             // data har ändrats sedan senaste beräkning
    result: null,            // { order, codes, plans, steps, firstStep, lastStep }
    stepIndex: -1,
    mode: "one",             // "one" | "all"
    viewArticle: null,
    followStep: true,        // false när användaren själv valt en flik
    playTimer: null,
    lastScrolledArticle: null,
    cells: new Map()         // cell-nyckel → <td>
};

/* =====================================================================
   Hjälpfunktioner
   ===================================================================== */

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function fmt(value) {
    if (value === undefined || value === null) {
        return "";
    }

    const rounded = Math.round(value * 100) / 100;

    return String(rounded).replace("-", "−");
}

// Negativa tal inom parentes i formler, t.ex. 50 − (−20)
function par(value) {
    return value < 0 ? `(${fmt(value)})` : fmt(value);
}

function toNumber(value, { min = 0, integer = false } = {}) {
    let number = Number(String(value).replace(",", "."));

    if (!Number.isFinite(number)) {
        number = min;
    }

    if (integer) {
        number = Math.round(number);
    }

    return Math.max(min, number);
}

function cellKey(articleId, row, period) {
    return `${articleId}|${row}|${period}`;
}

function getArticle(id) {
    return state.articles.find(article => article.id === id);
}

function childLinks(id) {
    return state.bom.filter(link => link.parent === id);
}

function parentLinks(id) {
    return state.bom.filter(link => link.child === id);
}

// Ligger "target" någonstans i strukturen under "from" (eller är det samma)?
function isInSubtree(from, target) {
    if (from === target) {
        return true;
    }

    return childLinks(from).some(link => isInSubtree(link.child, target));
}

function createArticle(id, description) {
    return {
        id,
        description,
        leadTime: 1,
        initialStock: 0,
        safetyStock: 0,
        scheduledReceipt: 0,
        scheduledReceiptPeriod: 1,
        lotMethod: "LFL",
        lotValue: 1
    };
}

function lowLevelCodes() {
    const codes = {};

    if (!state.rootId) {
        return codes;
    }

    function visit(id, level, path) {
        if (path.includes(id)) {
            throw new Error("Produktstrukturen innehåller en cirkulär koppling.");
        }

        codes[id] = Math.max(codes[id] ?? 0, level);

        childLinks(id).forEach(link =>
            visit(link.child, level + 1, [...path, id])
        );
    }

    visit(state.rootId, 0, []);

    return codes;
}

// Artiklar i lägsta-nivå-ordning (stabil sortering behåller inmatningsordningen)
function orderedArticles(codes) {
    return state.articles
        .filter(article => codes[article.id] !== undefined)
        .sort((a, b) => codes[a.id] - codes[b.id]);
}

// Tar bort artiklar som inte längre sitter någonstans i strukturen
function pruneOrphans() {
    let changed = true;

    while (changed) {
        changed = false;

        state.articles = state.articles.filter(article => {
            const keep =
                article.id === state.rootId ||
                parentLinks(article.id).length > 0;

            if (!keep) {
                state.bom = state.bom.filter(link => link.parent !== article.id);
                changed = true;
            }

            return keep;
        });
    }
}

function markDirty() {
    ui.dirty = true;
}

/* =====================================================================
   Sida 1: Perioder & behov
   ===================================================================== */

// Den rad som matas in på sida 1: prognos eller given huvudplan
function demandInput() {
    return state.source === "mps"
        ? { values: state.mps, label: "MPS start" }
        : { values: state.forecast, label: "Prognos" };
}

function renderForecast() {
    const { values, label } = demandInput();
    const givenMps = state.source === "mps";

    $("#numberOfPeriods").value = state.periods;
    $("#sourceForecast").classList.toggle("active", !givenMps);
    $("#sourceMps").classList.toggle("active", givenMps);

    $("#demandHeading").textContent = givenMps
        ? "Huvudplan för slutprodukten"
        : "Prognos för slutprodukten";

    $("#demandNote").innerHTML = givenMps
        ? "Ange när tillverkningen av slutprodukten startar (MPS start). " +
          "Värdena exploderas direkt genom produktstrukturen och blir bruttobehov för komponenterna. " +
          "Slutproduktens lager- och partiformningsdata används inte."
        : "Prognosen är slutproduktens oberoende behov och blir bruttobehov i huvudplanen.";

    const headers = values
        .map((_, index) => `<th>${index + 1}</th>`)
        .join("");

    const inputs = values
        .map((value, index) => `
            <td>
                <input
                    type="number"
                    min="0"
                    data-index="${index}"
                    value="${value}"
                    aria-label="${label} period ${index + 1}"
                >
            </td>
        `)
        .join("");

    $("#forecastTable").innerHTML = `
        <thead>
            <tr><th class="row-heading">Period</th>${headers}</tr>
        </thead>
        <tbody>
            <tr><th class="row-heading">${label}</th>${inputs}</tr>
        </tbody>
    `;
}

function setSource(source) {
    state.source = source;

    markDirty();
    renderForecast();
    renderArticleEditor();
}

function resizeToPeriods(values, periods) {
    while (values.length < periods) {
        values.push(0);
    }

    return values.slice(0, periods);
}

function setPeriods(value) {
    const periods = Math.min(24, Math.max(3, toNumber(value, { integer: true }) || 8));

    state.periods = periods;
    state.forecast = resizeToPeriods(state.forecast, periods);
    state.mps = resizeToPeriods(state.mps, periods);

    markDirty();
    renderForecast();
}

/* =====================================================================
   Sida 2: Produktstruktur
   ===================================================================== */

function renderBomEditor() {
    const container = $("#bomEditor");

    if (!state.rootId) {
        container.innerHTML = `
            <p>Börja med att skapa slutprodukten.</p>

            <form class="root-form" id="rootForm">
                <div class="field">
                    <label for="rootId">Artikelnummer</label>
                    <input id="rootId" required placeholder="t.ex. Z">
                </div>

                <div class="field">
                    <label for="rootDescription">Beskrivning</label>
                    <input id="rootDescription" placeholder="t.ex. Fotbollssko">
                </div>

                <button class="primary" type="submit">Skapa slutprodukt</button>
            </form>
        `;

        $("#rootForm").addEventListener("submit", event => {
            event.preventDefault();

            const id = $("#rootId").value.trim();

            if (!id) {
                return;
            }

            state.articles = [createArticle(id, $("#rootDescription").value.trim())];
            state.bom = [];
            state.rootId = id;

            markDirty();
            renderBomEditor();
            renderArticleEditor();
        });

        $("#rootId").focus();
        return;
    }

    let codes = {};

    try {
        codes = lowLevelCodes();
    } catch {
        codes = {};
    }

    container.innerHTML = `
        <ul class="bom-tree">
            ${renderTreeNode(state.rootId, null, [], codes)}
        </ul>

        <p>
            <button class="danger small-button" data-action="clear-product">
                Ta bort hela produktstrukturen
            </button>
        </p>
    `;

    const form = container.querySelector(".add-form");

    if (form) {
        setupAddForm(form);
    }
}

function renderTreeNode(id, link, path, codes) {
    const article = getArticle(id);
    const currentPath = [...path, id];
    const pathKey = currentPath.join(">");
    const isRoot = link === null;

    const quantity = isRoot
        ? ""
        : `
            <label class="node-qty" title="Antal per ${esc(link.parent)}">
                ×
                <input
                    type="number"
                    min="0.001"
                    step="any"
                    value="${link.quantity}"
                    data-action="quantity"
                    data-parent="${esc(link.parent)}"
                    data-child="${esc(link.child)}"
                    aria-label="Antal ${esc(link.child)} per ${esc(link.parent)}"
                >
            </label>
        `;

    const remove = isRoot
        ? ""
        : `
            <button
                class="danger small-button"
                data-action="remove"
                data-parent="${esc(link.parent)}"
                data-child="${esc(link.child)}"
                title="Ta bort ${esc(link.child)} från ${esc(link.parent)}"
            >×</button>
        `;

    const addForm = ui.addingTo === pathKey
        ? `
            <form class="add-form" data-parent="${esc(id)}">
                <div class="field">
                    <label>Artikelnummer</label>
                    <input name="id" list="existingArticles" required autocomplete="off">
                </div>

                <div class="field">
                    <label>Beskrivning</label>
                    <input name="description">
                </div>

                <div class="field">
                    <label>Antal per ${esc(id)}</label>
                    <input class="qty-input" name="quantity" type="number" min="0.001" step="any" value="1" required>
                </div>

                <button class="primary small-button" type="submit">Lägg till</button>
                <button class="secondary small-button" type="button" data-action="cancel-add">Avbryt</button>

                <span class="hint small">
                    Anger du ett befintligt artikelnummer återanvänds artikeln.
                </span>

                <datalist id="existingArticles">
                    ${state.articles
                        .filter(candidate => !isInSubtree(candidate.id, id))
                        .map(candidate => `<option value="${esc(candidate.id)}">${esc(candidate.description)}</option>`)
                        .join("")}
                </datalist>
            </form>
        `
        : "";

    // Skydd mot oändlig rekursion om data ändå skulle vara cirkulär
    const children = path.includes(id)
        ? ""
        : childLinks(id)
            .map(child => renderTreeNode(child.child, child, currentPath, codes))
            .join("");

    return `
        <li>
            <div class="node ${isRoot ? "root" : ""}">
                <span class="node-id">${esc(id)}</span>
                <span class="node-desc">${esc(article?.description)}</span>
                ${quantity}
                <span class="level-badge">nivå ${codes[id] ?? "?"}</span>
                <button
                    class="secondary small-button"
                    data-action="add"
                    data-path="${esc(pathKey)}"
                >+ Komponent</button>
                ${remove}
            </div>

            ${addForm}

            ${children ? `<ul>${children}</ul>` : ""}
        </li>
    `;
}

function setupAddForm(form) {
    const idInput = form.elements.id;
    const descriptionInput = form.elements.description;
    const hint = form.querySelector(".hint");

    idInput.focus();

    idInput.addEventListener("input", () => {
        const existing = getArticle(idInput.value.trim());

        descriptionInput.disabled = Boolean(existing);
        descriptionInput.value = existing ? existing.description : descriptionInput.value;

        hint.textContent = existing
            ? `${existing.id} finns redan och återanvänds här.`
            : "Anger du ett befintligt artikelnummer återanvänds artikeln.";
    });

    form.addEventListener("submit", event => {
        event.preventDefault();

        const parent = form.dataset.parent;
        const id = idInput.value.trim();
        const quantity = toNumber(form.elements.quantity.value);

        if (!id || quantity <= 0) {
            return;
        }

        const existing = getArticle(id);

        if (existing && isInSubtree(id, parent)) {
            alert(`${id} kan inte läggas under ${parent} eftersom det skulle ge en cirkulär struktur.`);
            return;
        }

        if (state.bom.some(link => link.parent === parent && link.child === id)) {
            alert(`${id} finns redan direkt under ${parent}. Ändra antalet i stället.`);
            return;
        }

        if (!existing) {
            state.articles.push(createArticle(id, descriptionInput.value.trim()));
        }

        state.bom.push({ parent, child: id, quantity });

        ui.addingTo = null;

        markDirty();
        renderBomEditor();
        renderArticleEditor();
    });
}

function handleBomClick(event) {
    const button = event.target.closest("button[data-action]");

    if (!button) {
        return;
    }

    const { action, parent, child, path } = button.dataset;

    if (action === "add") {
        ui.addingTo = ui.addingTo === path ? null : path;
        renderBomEditor();
    }

    if (action === "cancel-add") {
        ui.addingTo = null;
        renderBomEditor();
    }

    if (action === "remove") {
        state.bom = state.bom.filter(link => !(link.parent === parent && link.child === child));
        pruneOrphans();

        ui.addingTo = null;

        markDirty();
        renderBomEditor();
        renderArticleEditor();
    }

    if (action === "clear-product") {
        if (!confirm("Ta bort hela produktstrukturen och all artikeldata?")) {
            return;
        }

        state.articles = [];
        state.bom = [];
        state.rootId = null;
        ui.addingTo = null;

        markDirty();
        renderBomEditor();
        renderArticleEditor();
    }
}

function handleBomChange(event) {
    const input = event.target;

    if (input.dataset.action !== "quantity") {
        return;
    }

    const link = state.bom.find(candidate =>
        candidate.parent === input.dataset.parent &&
        candidate.child === input.dataset.child
    );

    const quantity = toNumber(input.value);

    if (link && quantity > 0) {
        link.quantity = quantity;
        markDirty();
    } else if (link) {
        input.value = link.quantity;
    }
}

/* =====================================================================
   Sida 3: Artikeldata
   ===================================================================== */

function renderArticleEditor() {
    const container = $("#articleEditor");

    if (!state.rootId) {
        container.innerHTML = `<p>Skapa först produktstrukturen i steg 2.</p>`;
        return;
    }

    let codes;

    try {
        codes = lowLevelCodes();
    } catch (error) {
        container.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
        return;
    }

    const lotOptions = Object.entries(LOT_METHODS)
        .map(([key, method]) => `<option value="${key}">${esc(method.label)}</option>`)
        .join("");

    const rows = orderedArticles(codes)
        .map(article => {
            const method = LOT_METHODS[article.lotMethod];

            // Med en given huvudplan används inte slutproduktens planeringsdata
            if (article.id === state.rootId && state.source === "mps") {
                return `
                    <tr data-id="${esc(article.id)}">
                        <td><input data-field="id" value="${esc(article.id)}" aria-label="Artikelnummer"></td>
                        <td><input data-field="description" value="${esc(article.description)}" aria-label="Beskrivning"></td>
                        <td>${codes[article.id]} <span class="small">(slutprodukt)</span></td>
                        <td colspan="7" class="given-note">
                            Styrs av den givna huvudplanen (MPS start) – dessa uppgifter behövs inte.
                        </td>
                    </tr>
                `;
            }

            return `
                <tr data-id="${esc(article.id)}">
                    <td><input data-field="id" value="${esc(article.id)}" aria-label="Artikelnummer"></td>
                    <td><input data-field="description" value="${esc(article.description)}" aria-label="Beskrivning"></td>
                    <td>${codes[article.id]}${article.id === state.rootId ? " <span class=\"small\">(slutprodukt)</span>" : ""}</td>
                    <td><input data-field="leadTime" type="number" min="0" step="1" value="${article.leadTime}" aria-label="Ledtid"></td>
                    <td><input data-field="initialStock" type="number" min="0" value="${article.initialStock}" aria-label="Ingående lager"></td>
                    <td><input data-field="safetyStock" type="number" min="0" value="${article.safetyStock}" aria-label="Säkerhetslager"></td>
                    <td><input data-field="scheduledReceipt" type="number" min="0" value="${article.scheduledReceipt}" aria-label="Förväntad inleverans, antal"></td>
                    <td><input data-field="scheduledReceiptPeriod" type="number" min="1" max="${state.periods}" step="1" value="${article.scheduledReceiptPeriod}" aria-label="Förväntad inleverans, period"></td>
                    <td>
                        <select data-field="lotMethod" aria-label="Partiformningsmetod">${lotOptions}</select>
                    </td>
                    <td>
                        <input
                            data-field="lotValue"
                            type="number"
                            min="1"
                            value="${method.valueLabel ? article.lotValue : ""}"
                            ${method.valueLabel ? "" : "disabled"}
                            aria-label="Partiformningsindata"
                        >
                        <span class="lot-hint">${esc(method.valueLabel ?? "behövs inte")}</span>
                    </td>
                </tr>
            `;
        })
        .join("");

    container.innerHTML = `
        <div class="table-wrapper">
            <table class="article-table">
                <thead>
                    <tr>
                        <th>Artikelnr</th>
                        <th>Beskrivning</th>
                        <th>Lägsta-<br>nivå-kod</th>
                        <th>Ledtid<br>(perioder)</th>
                        <th>Ingående<br>lager</th>
                        <th>Säkerhets-<br>lager</th>
                        <th>Förv. inlev.<br>antal</th>
                        <th>Förv. inlev.<br>period</th>
                        <th>Partiformning</th>
                        <th>Partiformnings-<br>indata</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>

        <div class="note">
            Ändringar sparas direkt. Förväntad inleverans är en redan
            frisläppt order som levereras i angiven period.
        </div>
    `;

    container.querySelectorAll("tr[data-id]").forEach(row => {
        const article = getArticle(row.dataset.id);
        const lotSelect = row.querySelector('[data-field="lotMethod"]');

        if (lotSelect) {
            lotSelect.value = article.lotMethod;
        }
    });
}

function handleArticleChange(event) {
    const input = event.target;
    const field = input.dataset.field;
    const row = input.closest("tr[data-id]");

    if (!field || !row) {
        return;
    }

    const article = getArticle(row.dataset.id);

    if (!article) {
        return;
    }

    if (field === "id") {
        const newId = input.value.trim();

        if (newId === article.id) {
            return;
        }

        if (!newId || getArticle(newId)) {
            alert(newId ? `Artikelnumret ${newId} används redan.` : "Artikelnumret får inte vara tomt.");
            input.value = article.id;
            return;
        }

        state.bom.forEach(link => {
            if (link.parent === article.id) link.parent = newId;
            if (link.child === article.id) link.child = newId;
        });

        if (state.rootId === article.id) {
            state.rootId = newId;
        }

        article.id = newId;
        row.dataset.id = newId;

        markDirty();
        renderBomEditor();
        return;
    }

    if (field === "description") {
        article.description = input.value.trim();
        markDirty();
        renderBomEditor();
        return;
    }

    if (field === "lotMethod") {
        article.lotMethod = input.value;
        article.lotValue = LOT_METHODS[input.value].defaultValue;
        markDirty();
        renderArticleEditor();
        return;
    }

    const rules = {
        leadTime: { min: 0, integer: true },
        initialStock: { min: 0 },
        safetyStock: { min: 0 },
        scheduledReceipt: { min: 0 },
        scheduledReceiptPeriod: { min: 1, integer: true },
        lotValue: { min: 1, integer: true }
    };

    article[field] = toNumber(input.value, rules[field]);
    input.value = article[field];

    markDirty();
}

/* =====================================================================
   Beräkning
   Varje plan räknas fram cell för cell och varje beräkning sparas som
   ett "steg" som animationen sedan spelar upp.
   ===================================================================== */

function calculateAll() {
    const codes = lowLevelCodes();
    const order = orderedArticles(codes);
    const plans = {};
    const steps = [];

    // Celler som är kända från början och visas direkt: prognosen
    // (eller den givna huvudplanen) och ingående lager (kolumn −1)
    const givenMps = state.source === "mps";

    const initialWrites = [
        ...range(0, state.periods).map(p => ({
            article: state.rootId,
            row: givenMps ? "rel" : "gross",
            period: p,
            value: givenMps ? state.mps[p] : state.forecast[p]
        })),
        ...order.flatMap(article => ["bal", "pab"].map(row => ({
            article: article.id,
            row,
            period: -1,
            value: article.initialStock
        })))
    ];

    order.forEach(article => {
        plans[article.id] = calculateArticle(article, plans, steps, order);
        plans[article.id].lowLevelCode = codes[article.id];
    });

    const firstStep = {};
    const lastStep = {};

    steps.forEach((step, index) => {
        firstStep[step.article] ??= index;
        lastStep[step.article] = index;
    });

    return { order, codes, plans, steps, initialWrites, firstStep, lastStep };
}

function calculateArticle(article, plans, steps, order) {
    const id = article.id;
    const P = state.periods;
    const isMain = id === state.rootId;
    const L = article.leadTime;
    const SS = article.safetyStock;
    const method = LOT_METHODS[article.lotMethod] ?? LOT_METHODS.LFL;

    // Given huvudplan: slutproduktens MPS start är indata och räknas inte fram
    const givenMps = isMain && state.source === "mps";

    const sources = isMain
        ? []
        : parentLinks(id).map(link => ({
            parent: link.parent,
            quantity: link.quantity,
            values: plans[link.parent].rel.map(value => value * link.quantity)
        }));

    const plan = {
        isMain,
        sources,
        gross: Array(P).fill(0),
        sched: Array(P).fill(0),
        bal: Array(P).fill(0),
        net: Array(P).fill(0),
        lot: Array(P).fill(0),
        rec: Array(P).fill(0),
        pab: Array(P).fill(0),
        rel: givenMps ? [...state.mps] : Array(P).fill(0),
        warnings: [],
        givenMps
    };

    const showSched = !isMain || article.scheduledReceipt > 0;

    plan.rows = givenMps
        ? [{ key: "rel", label: "Produktionsprogr. (MPS) start", cls: "cell-release" }]
        : isMain
        ? [
            { key: "gross", label: "Prognos", cls: "cell-demand" },
            ...(showSched ? [{ key: "sched", label: "Förv. inlev. släppta order" }] : []),
            { key: "rec", label: "Produktionsprogr. (MPS) färdig", cls: "cell-receipt", event: true },
            { key: "pab", label: "Planerad lagerutveckling (PAB)", safety: SS },
            { key: "rel", label: "Produktionsprogr. (MPS) start", cls: "cell-release", event: true }
        ]
        : [
            { key: "gross", label: "Bruttobehov", cls: "cell-demand" },
            ...sources.map(source => ({
                key: `src:${source.parent}`,
                label: `↳ Från ${source.parent} × ${fmt(source.quantity)}`,
                source: true
            })),
            { key: "sched", label: "Förv. inlev. släppta order" },
            { key: "bal", label: "Lager mht förv. inlev.", safety: SS },
            { key: "net", label: "Nettobehov", event: true },
            { key: "lot", label: "Partiformning", event: true },
            { key: "rec", label: "Planerade order färdiga", cls: "cell-receipt", event: true },
            { key: "pab", label: "Planerad lagerutveckling", safety: SS },
            { key: "rel", label: "Planerade orderutsläpp", cls: "cell-release", event: true }
        ];

    // Bruttobehovet är känt i förväg (prognos eller moderartiklarnas utsläpp).
    // Det behövs för hela horisonten eftersom t.ex. POQ blickar framåt.
    for (let p = 0; p < P; p++) {
        plan.gross[p] = isMain
            ? state.forecast[p]
            : sources.reduce((sum, source) => sum + source.values[p], 0);
    }

    const cell = (row, period, articleId = id) => ({ article: articleId, row, period });

    const addStep = (period, title, text, writes, refs = []) => {
        steps.push({
            article: id,
            period,
            title,
            text,
            writes: writes.map(write => ({ article: id, ...write })),
            refs
        });
    };

    // En given huvudplan räknas inte fram, den exploderas bara (nedan)
    const periodsToCalculate = givenMps ? 0 : P;

    for (let p = 0; p < periodsToCalculate; p++) {
        const periodName = `period ${p + 1}`;

        // Kolumnen före period 1 (index −1) innehåller ingående lager
        const opening = p === 0 ? article.initialStock : plan.pab[p - 1];
        const openingRefs = [cell("pab", p - 1)];
        const openingText = p === 0 ? "ingående lager" : `PAB period ${p}`;

        const previousBal = p === 0 ? article.initialStock : plan.bal[p - 1];
        const previousBalText = p === 0 ? "ingående lager" : `period ${p}`;

        // Bruttobehovet animeras inte: prognosen visas från början och
        // komponenternas behov visas när moderartikelns plan är klar.

        /* --- Förväntade inleveranser --- */

        plan.sched[p] = article.scheduledReceiptPeriod - 1 === p ? article.scheduledReceipt : 0;

        if (showSched) {
            addStep(
                p,
                "Förväntad inleverans",
                plan.sched[p] > 0
                    ? `En redan frisläppt order på <b>${fmt(plan.sched[p])}</b> levereras i ${periodName}.`
                    : `Ingen redan frisläppt order levereras i ${periodName}.`,
                [{ row: "sched", period: p, value: plan.sched[p] }]
            );
        }

        /* --- Lager mht förväntade inleveranser ---
           Löpande lager som bara tar hänsyn till bruttobehov och redan
           frisläppta order (inte planerade order). Kan bli negativt. */

        plan.bal[p] = previousBal + plan.sched[p] - plan.gross[p];

        if (!isMain) {
            addStep(
                p,
                "Lager med hänsyn till förväntade inleveranser",
                `<span class="formula">Lager = ${fmt(previousBal)} (${previousBalText}) + ${fmt(plan.sched[p])} − ${fmt(plan.gross[p])} = <b>${fmt(plan.bal[p])}</b></span><br>` +
                `<span class="small">Planerade order räknas inte med i denna rad.</span>`,
                [{ row: "bal", period: p, value: plan.bal[p] }],
                [cell("bal", p - 1), cell("sched", p), cell("gross", p)]
            );
        }

        /* --- Nettobehov ---
           Ökningen av underskottet mot säkerhetslagret denna period. */

        const shortage = Math.max(0, SS - plan.bal[p]);
        const previousShortage = p === 0 ? 0 : Math.max(0, SS - plan.bal[p - 1]);

        plan.net[p] = Math.max(0, shortage - previousShortage);

        let netText;

        if (plan.bal[p] >= SS) {
            netText = `Lager ${fmt(plan.bal[p])} ≥ säkerhetslager ${fmt(SS)} → inget nettobehov.`;
        } else if (previousShortage === 0) {
            netText =
                `Lager ${fmt(plan.bal[p])} < säkerhetslager ${fmt(SS)} → ` +
                `<span class="formula">nettobehov = ${fmt(SS)} − ${par(plan.bal[p])} = <b>${fmt(plan.net[p])}</b></span>`;
        } else {
            netText =
                `Lagret låg redan under säkerhetslagret i ${previousBalText}, så nettobehovet är bara ökningen av underskottet: ` +
                `<span class="formula">${par(previousBal)} − ${par(plan.bal[p])} = <b>${fmt(plan.net[p])}</b></span>`;
        }

        /* --- Behövs en ny order? Avgörs av planerad lagerutveckling --- */

        const projected = opening + plan.sched[p] - plan.gross[p];

        const projectedFormula =
            `${fmt(opening)} (${openingText}) + ${fmt(plan.sched[p])} − ${fmt(plan.gross[p])} = ${fmt(projected)}`;

        const projectedRefs = [...openingRefs, cell("sched", p), cell("gross", p)];

        let lotText = "";

        if (projected < SS) {
            const requirement = SS - projected;

            const lotResult = method.calculate({
                requirement,
                lotValue: article.lotValue,
                periodIndex: p,
                grossRequirements: plan.gross,
                availableBeforeDemand: opening + plan.sched[p],
                safetyStock: SS
            });

            plan.lot[p] = Math.ceil(lotResult.quantity);
            plan.rec[p] = plan.lot[p];

            lotText =
                `<span class="formula">Lager före ny order = ${projectedFormula}</span> < säkerhetslager ${fmt(SS)}, ` +
                `så det fattas <span class="formula">${fmt(SS)} − ${par(projected)} = ${fmt(requirement)}</span>.<br>` +
                esc(lotResult.explanation);
        }

        const noOrderText =
            `<span class="formula">Lager före ny order = ${projectedFormula}</span> ≥ säkerhetslager ${fmt(SS)} → ingen ny order behövs` +
            (plan.net[p] > 0 ? ", nettobehovet täcks av en tidigare planerad order." : ".");

        if (isMain) {
            addStep(
                p,
                "Produktionsprogram (MPS) färdigt",
                plan.rec[p] > 0
                    ? `${lotText}<br>En order på <b>${fmt(plan.rec[p])}</b> ska vara färdig i ${periodName}.`
                    : noOrderText,
                [{ row: "rec", period: p, value: plan.rec[p] }],
                projectedRefs
            );
        } else if (plan.net[p] === 0 && plan.rec[p] === 0) {
            addStep(
                p,
                "Nettobehov",
                `${netText}<br>${noOrderText}`,
                [
                    { row: "net", period: p, value: 0 },
                    { row: "lot", period: p, value: 0 },
                    { row: "rec", period: p, value: 0 }
                ],
                [cell("bal", p), cell("bal", p - 1)]
            );
        } else {
            addStep(
                p,
                "Nettobehov",
                netText,
                [{ row: "net", period: p, value: plan.net[p] }],
                [cell("bal", p), cell("bal", p - 1)]
            );

            if (plan.rec[p] > 0) {
                addStep(
                    p,
                    "Partiformning",
                    lotText,
                    [{ row: "lot", period: p, value: plan.lot[p] }],
                    article.lotMethod === "POQ"
                        ? [...openingRefs, cell("sched", p), ...range(p, Math.min(P, p + article.lotValue)).map(q => cell("gross", q))]
                        : projectedRefs
                );

                addStep(
                    p,
                    "Planerad order färdig",
                    `Partiformningen ger en planerad order på <b>${fmt(plan.rec[p])}</b> som ska vara färdig i ${periodName}.`,
                    [{ row: "rec", period: p, value: plan.rec[p] }],
                    [cell("lot", p)]
                );
            } else {
                addStep(
                    p,
                    "Partiformning",
                    noOrderText,
                    [
                        { row: "lot", period: p, value: 0 },
                        { row: "rec", period: p, value: 0 }
                    ],
                    projectedRefs
                );
            }
        }

        /* --- Planerad lagerutveckling --- */

        plan.pab[p] = projected + plan.rec[p];

        addStep(
            p,
            isMain ? "Planerad lagerutveckling (PAB)" : "Planerad lagerutveckling",
            `<span class="formula">PAB = ${fmt(opening)} (${openingText}) + ${fmt(plan.sched[p])} − ${fmt(plan.gross[p])} + ${fmt(plan.rec[p])} = <b>${fmt(plan.pab[p])}</b></span>`,
            [{ row: "pab", period: p, value: plan.pab[p] }],
            [...projectedRefs, cell("rec", p)]
        );

        /* --- Planerat orderutsläpp (ledtidsförskjutning) --- */

        if (plan.rec[p] > 0) {
            const releasePeriod = p - L;

            if (releasePeriod >= 0) {
                plan.rel[releasePeriod] += plan.rec[p];

                addStep(
                    p,
                    isMain ? "Produktionsprogram (MPS) start" : "Planerat orderutsläpp",
                    `Ordern på ${fmt(plan.rec[p])} ska vara färdig i ${periodName}. ` +
                    `Med ledtid ${L} måste den släppas <b>${L} period${L === 1 ? "" : "er"} tidigare</b>, ` +
                    `alltså i period ${releasePeriod + 1}.`,
                    [{ row: "rel", period: releasePeriod, value: plan.rel[releasePeriod] }],
                    [cell("rec", p)]
                );
            } else {
                const warning =
                    `Ordern på ${fmt(plan.rec[p])} för ${periodName} borde ha släppts ` +
                    `${-releasePeriod} period(er) före period 1.`;

                plan.warnings.push(warning);

                addStep(
                    p,
                    "Orderutsläpp utanför planeringshorisonten",
                    `<span class="warning">⚠ ${esc(warning)}</span> Ordern måste brådskas eller ledtiden kortas.`,
                    [],
                    [cell("rec", p)]
                );
            }
        }
    }

    /* --- Planen klar: orderutsläppen skickas vidare --- */

    const childWrites = [];
    const explosionText = [];

    childLinks(id).forEach(link => {
        const values = plan.rel.map(value => value * link.quantity);

        range(0, P).forEach(p =>
            childWrites.push({ article: link.child, row: `src:${id}`, period: p, value: values[p] })
        );

        // Är detta komponentens sista moderartikel är bruttobehovet komplett
        const parentIds = parentLinks(link.child).map(parent => parent.parent);
        const lastParent = order
            .filter(candidate => parentIds.includes(candidate.id))
            .at(-1).id;

        const complete = lastParent === id;

        if (complete) {
            const gross = range(0, P).map(p =>
                parentLinks(link.child).reduce((sum, parent) => {
                    const parentRel = parent.parent === id ? plan.rel : plans[parent.parent].rel;
                    return sum + parentRel[p] * parent.quantity;
                }, 0)
            );

            range(0, P).forEach(p =>
                childWrites.push({ article: link.child, row: "gross", period: p, value: gross[p] })
            );
        }

        explosionText.push(
            `<b>${esc(link.child)}</b>: orderutsläpp × ${fmt(link.quantity)}` +
            (complete
                ? (parentIds.length > 1 ? " – nu är alla behovskällor kända och bruttobehovet summeras." : " = bruttobehov.")
                : ` – väntar på fler behovskällor (${parentIds.filter(parent => parent !== id).map(esc).join(", ")}).`)
        );
    });

    addStep(
        null,
        givenMps
            ? "Huvudplanen är given"
            : isMain ? "Huvudplanen är klar" : `Materialplanen för ${id} är klar`,
        explosionText.length > 0
            ? `${isMain ? "MPS start" : "De planerade orderutsläppen"} exploderas genom produktstrukturen:<br>` +
              explosionText.join("<br>")
            : `${esc(id)} har inga komponenter, så orderutsläppen skapar inga fler behov.`,
        [
            ...range(0, P).map(p => ({ row: "rel", period: p, value: plan.rel[p] })),
            ...childWrites
        ],
        range(0, P).map(p => cell("rel", p))
    );

    return plan;
}

function range(start, end) {
    return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

/* =====================================================================
   Sida 4: Planer – uppbyggnad av tabeller
   ===================================================================== */

function validate() {
    const errors = [];

    if (!state.rootId) {
        errors.push("Det finns ingen slutprodukt. Skapa den under <b>2. Produktstruktur</b>.");
        return errors;
    }

    try {
        lowLevelCodes();
    } catch (error) {
        errors.push(esc(error.message));
    }

    state.articles.forEach(article => {
        const unused = article.id === state.rootId && state.source === "mps";

        if (!unused && article.scheduledReceipt > 0 && article.scheduledReceiptPeriod > state.periods) {
            errors.push(
                `${esc(article.id)}: förväntad inleverans i period ${article.scheduledReceiptPeriod} ` +
                `ligger utanför planeringshorisonten (${state.periods} perioder).`
            );
        }
    });

    return errors;
}

function preparePlans() {
    stopPlaying();

    const errors = validate();

    if (errors.length > 0) {
        $("#planErrors").innerHTML = `<div class="error-box">${errors.join("<br>")}</div>`;
        $("#planArea").style.display = "none";
        ui.result = null;
        return;
    }

    $("#planErrors").innerHTML = "";
    $("#planArea").style.display = "";

    if (!ui.dirty && ui.result) {
        return;
    }

    ui.result = calculateAll();
    ui.dirty = false;
    ui.stepIndex = -1;
    ui.viewArticle = state.rootId;
    ui.followStep = true;
    ui.lastScrolledArticle = null;

    buildPlanTables();
    updatePlanView();
}

function buildPlanTables() {
    const { order, plans } = ui.result;

    ui.cells.clear();

    // Första kolumnen (index −1) visar ingående lager
    const headers =
        `<th class="init-col"></th>` +
        range(0, state.periods)
            .map(p => `<th data-col="${p}">${p + 1}</th>`)
            .join("");

    $("#planOutput").innerHTML = order
        .map(article => {
            const plan = plans[article.id];
            const method = LOT_METHODS[article.lotMethod];

            const rows = plan.rows
                .map(row => {
                    const initClass = ["bal", "pab"].includes(row.key) ? "init-col" : "init-col init-empty";

                    const cells = range(-1, state.periods)
                        .map(p => `
                            <td
                                data-key="${esc(cellKey(article.id, row.key, p))}"
                                data-base="${p === -1 ? initClass : ""}"
                            ></td>
                        `)
                        .join("");

                    return `
                        <tr class="${row.source ? "requirement-source-row" : ""}">
                            <th class="row-heading">${esc(row.label)}</th>
                            ${cells}
                        </tr>
                    `;
                })
                .join("");

            const sourceText = plan.givenMps
                ? "Huvudplanen är given. MPS start exploderas direkt till komponenterna."
                : plan.isMain
                    ? "Oberoende behov från slutproduktens prognos."
                    : plan.sources.map(source => `${esc(source.parent)} × ${fmt(source.quantity)}`).join(" + ");

            const title = plan.givenMps
                ? "Huvudplan (given)"
                : plan.isMain ? "Huvudplan" : "Materialplan";

            const metadata = plan.givenMps
                ? `
                    <div>
                        Artikelnr: <b>${esc(article.id)}</b><br>
                        Beskrivning: ${esc(article.description)}<br>
                        Typ: Slutprodukt
                    </div>
                    <div>
                        Huvudplanen är given som indata (MPS start).<br>
                        Lager och partiformning för slutprodukten används inte.
                    </div>
                `
                : `
                    <div>
                        Artikelnr: <b>${esc(article.id)}</b><br>
                        Beskrivning: ${esc(article.description)}<br>
                        Ledtid: ${article.leadTime} period(er)<br>
                        Typ: ${plan.isMain ? "Slutprodukt" : "Komponent"}
                    </div>
                    <div>
                        Ingående lager: ${fmt(article.initialStock)}<br>
                        Säkerhetslager: ${fmt(article.safetyStock)}<br>
                        Partiformning: ${esc(article.lotMethod)}<br>
                        ${method.valueLabel ? `${esc(method.valueLabel)}: ${fmt(article.lotValue)}` : "&nbsp;"}
                    </div>
                `;

            return `
                <section class="card plan-card" data-article="${esc(article.id)}">
                    <div class="title-line">
                        <h2>${title} – ${esc(article.id)}</h2>
                        <span class="badge">Lägsta-nivå-kod: ${plan.lowLevelCode}</span>
                    </div>

                    <div class="metadata">${metadata}</div>

                    <div class="table-wrapper">
                        <table class="plan-table">
                            <thead>
                                <tr><th class="row-heading">Period</th>${headers}</tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>

                    <div class="source-description"><b>Behovskällor:</b> ${sourceText}</div>
                    <div class="plan-warnings small"></div>
                </section>
            `;
        })
        .join("");

    $$("#planOutput td[data-key]").forEach(td => ui.cells.set(td.dataset.key, td));

    // Radinformation behövs för färgläggning
    ui.rowInfo = new Map();

    order.forEach(article => {
        plans[article.id].rows.forEach(row =>
            ui.rowInfo.set(`${article.id}|${row.key}`, row)
        );
    });

    renderArticleTabs();
}

function renderArticleTabs() {
    const { order } = ui.result;

    $("#articleTabs").innerHTML = order
        .map((article, index) => `
            ${index > 0 ? '<span class="tab-arrow">→</span>' : ""}
            <button class="article-tab" data-article="${esc(article.id)}">
                ${esc(article.id)}<span class="tab-state"></span>
            </button>
        `)
        .join("");
}

/* =====================================================================
   Sida 4: Planer – animation
   ===================================================================== */

function updatePlanView() {
    const result = ui.result;

    if (!result) {
        return;
    }

    const { steps, order, firstStep, lastStep } = result;
    const k = ui.stepIndex;
    const current = steps[k];

    // Värden fram till och med aktuellt steg
    const values = new Map();
    const recent = new Set();
    const visitedColumns = {};

    result.initialWrites.forEach(write =>
        values.set(cellKey(write.article, write.row, write.period), write.value)
    );

    for (let i = 0; i <= k; i++) {
        const step = steps[i];

        step.writes.forEach(write =>
            values.set(cellKey(write.article, write.row, write.period), write.value)
        );

        if (step.period !== null) {
            visitedColumns[step.article] = Math.max(visitedColumns[step.article] ?? -1, step.period);
        }

        if (current && step.article === current.article && step.period === current.period && current.period !== null) {
            step.writes.forEach(write =>
                recent.add(cellKey(write.article, write.row, write.period))
            );
        }
    }

    const currentCells = new Set(
        (current?.writes ?? []).map(write => cellKey(write.article, write.row, write.period))
    );

    const refCells = new Set(
        (current?.refs ?? []).map(ref => cellKey(ref.article, ref.row, ref.period))
    );

    const isComplete = articleId => k >= lastStep[articleId];

    ui.cells.forEach((td, key) => {
        const [articleId, rowKey, periodText] = key.split("|");
        const period = Number(periodText);
        const row = ui.rowInfo.get(`${articleId}|${rowKey}`);
        const hasValue = values.has(key);
        const value = values.get(key);
        const visited = isComplete(articleId) || period <= (visitedColumns[articleId] ?? -1);
        const isCurrentColumn =
            current && current.article === articleId && current.period === period;

        td.textContent = hasValue ? fmt(value) : "";

        td.className = [
            td.dataset.base,
            !visited && !hasValue ? "future" : "",
            isCurrentColumn ? "col-current" : "",
            hasValue && row?.cls ? row.cls : "",
            hasValue && row?.event && value === 0 ? "zero" : "",
            hasValue && row?.safety !== undefined && value < row.safety ? "cell-warning" : "",
            recent.has(key) ? "cell-recent" : "",
            refCells.has(key) ? "cell-ref" : "",
            currentCells.has(key) ? "cell-current" : ""
        ].filter(Boolean).join(" ");

        // Starta om pop-animationen även om cellen redan hade klassen
        if (currentCells.has(key)) {
            td.style.animation = "none";
            void td.offsetWidth;
            td.style.animation = "";
        }
    });

    // Kolumnrubriker
    $$("#planOutput .plan-card").forEach(card => {
        const articleId = card.dataset.article;

        card.querySelectorAll("th[data-col]").forEach(th => {
            th.classList.toggle(
                "col-current",
                Boolean(current && current.article === articleId && current.period === Number(th.dataset.col))
            );
        });

        const warnings = result.plans[articleId].warnings;

        card.querySelector(".plan-warnings").innerHTML = isComplete(articleId) && !result.plans[articleId].givenMps
            ? `<b>Åtgärdsförslag:</b> ${warnings.length > 0 ? warnings.map(esc).join(" ") : "Inga order behöver frisläppas före planeringshorisonten."}`
            : "";
    });

    // Vilken tabell visas? Följer beräkningen om man inte valt en flik själv.
    if (ui.followStep) {
        ui.viewArticle = current ? current.article : state.rootId;
    }

    $$("#planOutput .plan-card").forEach(card => {
        card.classList.toggle(
            "hidden",
            ui.mode === "one" && card.dataset.article !== ui.viewArticle
        );
    });

    // Flikar per artikel
    $$("#articleTabs .article-tab").forEach(tab => {
        const id = tab.dataset.article;
        const done = isComplete(id);
        const running = !done && k >= firstStep[id];

        tab.classList.toggle("done", done);
        tab.classList.toggle("running", running);
        tab.classList.toggle("viewing", ui.mode === "one" && id === ui.viewArticle);
        tab.querySelector(".tab-state").textContent = done ? "✓" : running ? "…" : "";
    });

    // Förklaring
    if (current) {
        const article = getArticle(current.article);
        const where = current.period !== null ? ` · period ${current.period + 1}` : "";

        $("#explanation").innerHTML =
            `<span class="exp-title">${esc(article?.id ?? current.article)}${where} – ${esc(current.title)}</span>` +
            current.text;
    } else {
        $("#explanation").innerHTML =
            `<span class="exp-title">Redo att börja</span>` +
            `Beräkningen sker i lägsta-nivå-ordning: ${order.map(a => esc(a.id)).join(" → ")}. ` +
            `Tryck <b>Steg ▶</b> eller <b>▶ Spela</b> för att fylla i tabellerna cell för cell.`;
    }

    $("#stepCounter").textContent = `Steg ${k + 1} / ${steps.length}`;

    $("#stepPrev").disabled = k < 0;
    $("#stepPrevPeriod").disabled = k < 0;
    $("#stepFirst").disabled = k < 0;
    $("#stepNext").disabled = k >= steps.length - 1;
    $("#stepNextPeriod").disabled = k >= steps.length - 1;
    $("#stepLast").disabled = k >= steps.length - 1;

    $("#modeOne").classList.toggle("active", ui.mode === "one");
    $("#modeAll").classList.toggle("active", ui.mode === "all");

    // I läget "alla tabeller": scrolla till tabellen som räknas
    if (ui.mode === "all" && current && current.article !== ui.lastScrolledArticle) {
        const card = $(`#planOutput .plan-card[data-article="${CSS.escape(current.article)}"]`);
        card?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    ui.lastScrolledArticle = current?.article ?? null;
}

function goToStep(index) {
    const max = ui.result.steps.length - 1;

    ui.stepIndex = Math.max(-1, Math.min(max, index));
    ui.followStep = true;

    updatePlanView();
}

// Grupp = samma artikel och period
function sameGroup(a, b) {
    return a && b && a.article === b.article && a.period === b.period;
}

function nextPeriod() {
    const steps = ui.result.steps;
    let index = ui.stepIndex + 1;

    while (index + 1 < steps.length && sameGroup(steps[index], steps[index + 1])) {
        index++;
    }

    goToStep(index);
}

function previousPeriod() {
    const steps = ui.result.steps;
    let index = ui.stepIndex;

    // Gå till början av aktuell grupp, och därefter till slutet av föregående
    while (index > 0 && sameGroup(steps[index], steps[index - 1])) {
        index--;
    }

    goToStep(index - 1);
}

function playDelay() {
    const speed = Number($("#speed").value);

    return Math.round(2600 / speed);
}

function startPlaying() {
    if (!ui.result || ui.stepIndex >= ui.result.steps.length - 1) {
        if (ui.result) goToStep(-1);
    }

    $("#playPause").textContent = "⏸ Paus";

    const tick = () => {
        if (ui.stepIndex >= ui.result.steps.length - 1) {
            stopPlaying();
            return;
        }

        goToStep(ui.stepIndex + 1);
        ui.playTimer = setTimeout(tick, playDelay());
    };

    ui.playTimer = setTimeout(tick, 150);
}

function stopPlaying() {
    clearTimeout(ui.playTimer);
    ui.playTimer = null;
    $("#playPause").textContent = "▶ Spela";
}

function togglePlay() {
    if (ui.playTimer) {
        stopPlaying();
    } else {
        startPlaying();
    }
}

function handleArticleTabClick(event) {
    const tab = event.target.closest(".article-tab");

    if (!tab || !ui.result) {
        return;
    }

    stopPlaying();

    const id = tab.dataset.article;
    const first = ui.result.firstStep[id];

    if (ui.mode === "all") {
        $(`#planOutput .plan-card[data-article="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }

    // Inte påbörjad än: gör klart allt före och visa tabellen tom
    if (ui.stepIndex < first) {
        ui.stepIndex = first - 1;
    }

    ui.viewArticle = id;
    ui.followStep = false;

    updatePlanView();
}

/* =====================================================================
   Navigering och händelser
   ===================================================================== */

function showPage(pageId) {
    $$(".page").forEach(page => page.classList.toggle("active", page.id === pageId));
    $$(".wizard-step").forEach(step => step.classList.toggle("active", step.dataset.page === pageId));

    if (pageId !== "pagePlans") {
        stopPlaying();
    }

    if (pageId === "pageBom") renderBomEditor();
    if (pageId === "pageArticles") renderArticleEditor();
    if (pageId === "pagePlans") preparePlans();

    window.scrollTo({ top: 0 });
}

function resetAll() {
    if (!confirm("Rensa alla perioder, prognoser, produktstruktur och artikeldata?")) {
        return;
    }

    state.periods = 8;
    state.source = "forecast";
    state.forecast = Array(8).fill(0);
    state.mps = Array(8).fill(0);
    state.articles = [];
    state.bom = [];
    state.rootId = null;
    ui.addingTo = null;
    ui.result = null;

    markDirty();
    renderForecast();
    renderBomEditor();
    renderArticleEditor();
    showPage("pagePeriods");
}

$$(".wizard-step").forEach(button =>
    button.addEventListener("click", () => showPage(button.dataset.page))
);

$$("[data-goto]").forEach(button =>
    button.addEventListener("click", () => showPage(button.dataset.goto))
);

$("#resetAll").addEventListener("click", resetAll);

$("#numberOfPeriods").addEventListener("change", event => setPeriods(event.target.value));

$("#forecastTable").addEventListener("change", event => {
    const index = Number(event.target.dataset.index);

    if (Number.isInteger(index)) {
        const { values } = demandInput();

        values[index] = toNumber(event.target.value);
        event.target.value = values[index];
        markDirty();
    }
});

$("#sourceForecast").addEventListener("click", () => setSource("forecast"));
$("#sourceMps").addEventListener("click", () => setSource("mps"));

$("#bomEditor").addEventListener("click", handleBomClick);
$("#bomEditor").addEventListener("change", handleBomChange);
$("#articleEditor").addEventListener("change", handleArticleChange);

$("#modeOne").addEventListener("click", () => {
    ui.mode = "one";
    updatePlanView();
});

$("#modeAll").addEventListener("click", () => {
    ui.mode = "all";
    ui.lastScrolledArticle = null;
    updatePlanView();
});

$("#articleTabs").addEventListener("click", handleArticleTabClick);

$("#stepFirst").addEventListener("click", () => { stopPlaying(); goToStep(-1); });
$("#stepPrev").addEventListener("click", () => { stopPlaying(); goToStep(ui.stepIndex - 1); });
$("#stepNext").addEventListener("click", () => { stopPlaying(); goToStep(ui.stepIndex + 1); });
$("#stepPrevPeriod").addEventListener("click", () => { stopPlaying(); previousPeriod(); });
$("#stepNextPeriod").addEventListener("click", () => { stopPlaying(); nextPeriod(); });
$("#stepLast").addEventListener("click", () => { stopPlaying(); goToStep(Infinity); });
$("#playPause").addEventListener("click", togglePlay);

document.addEventListener("keydown", event => {
    const onPlans = $("#pagePlans").classList.contains("active");
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) &&
        document.activeElement.type !== "range";

    if (!onPlans || typing || !ui.result) {
        return;
    }

    if (event.key === "ArrowRight") {
        event.preventDefault();
        stopPlaying();
        event.shiftKey ? nextPeriod() : goToStep(ui.stepIndex + 1);
    } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stopPlaying();
        event.shiftKey ? previousPeriod() : goToStep(ui.stepIndex - 1);
    } else if (event.key === " ") {
        event.preventDefault();
        togglePlay();
    }
});

// Utskrift visar alla tabeller fullt ifyllda
let stepBeforePrint = null;

window.addEventListener("beforeprint", () => {
    if (ui.result) {
        stepBeforePrint = ui.stepIndex;
        goToStep(Infinity);
    }
});

window.addEventListener("afterprint", () => {
    if (ui.result && stepBeforePrint !== null) {
        goToStep(stepBeforePrint);
        stepBeforePrint = null;
    }
});

renderForecast();
renderBomEditor();
renderArticleEditor();