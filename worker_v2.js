/**
 * Cloudflare Worker – Proxy zur Anthropic Vision-API
 * OCR für Lieferscheine/Palettenzettel (druckerei-unabhängig)
 * Secrets: ANTHROPIC_API_KEY, ALLOWED_ORIGIN
 */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';

    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Nur POST erlaubt.' }, 405, cors);
    if (allowed !== '*' && origin && origin !== allowed) return json({ error: 'Origin nicht erlaubt.' }, 403, cors);

    let payload;
    try { payload = await request.json(); } catch { return json({ error: 'Ungültiges JSON.' }, 400, cors); }

    let images = [];
    if (Array.isArray(payload?.images)) images = payload.images.filter(x => typeof x === 'string');
    else if (typeof payload?.image === 'string') images = [payload.image];
    if (images.length === 0) return json({ error: 'Kein Bild übergeben.' }, 400, cors);

    const prompt = `Du bist ein erfahrener Mitarbeiter im Wareneingang einer Zeitungsdruckerei und liest Lieferscheine bzw. Palettenzettel von EINGEHENDEN Beilagen.

Wenn mehrere Fotos übergeben werden, gehören sie zu EINER Lieferung (z.B. mehrere Paletten desselben Auftrags).

=== TRÄGERZEITUNGEN (feste Liste) ===
Diese Titel sind TRÄGERZEITUNGEN. Sie gehören IMMER ins Feld "zeitung" (als Kürzel) und NIEMALS ins Feld "name":
- Fuldaer Zeitung -> FZ
- Marktkorb -> MK
- Bergwinkel Bote / Bergwinkel Wochenbote -> BW
- Ärzte Woche / Ärztewoche -> ÄW
- Cardio News / CardioNews -> CN
- Zahn Arzt / ZahnArzt -> ZA
- Ärzte Zeitung Rheumatologie / Rheuma -> RH
- Schlitzer Bote -> SB
- Kinzigtal Nachrichten -> KN
- Hünfelder Zeitung -> HZ

AUSNAHME: "Bad Soden-Salmünster" ist KEINE Trägerzeitung, sondern selbst eine Beilage (erscheint im Bergwinkel Boten). Steht dieser Titel da, gehört er in "name".

Signalwörter für eine Trägerzeitung: "Objekt", "Objekt Titel", "Verteiler", "für welches Objekt", "TZ", "Beilage in", "Beilage zu", "erscheint in", "Kunde".

VORSICHT bei "Objekt" und "Kunde": Das Feld kann BEIDES enthalten.
- "Objekt: Schlitzer Bote" -> Trägerzeitung -> zeitung="SB"
- "Objekt: Expert Klein" -> Werbekunde -> name="Expert Klein"
- "Objekt: 204.16 Switch_Guide Biologika Immunologie_Folder" -> Beilagenname -> name="Biologika"
Entscheide anhand der Liste oben: Steht dort ein gelisteter Zeitungstitel -> zeitung. Sonst -> name.

Auch ein Ausgaben-/Heftcode verrät die Trägerzeitung: Kürzel vorne wie in "CN 04/26" oder "ZA 5/26" -> zeitung.

=== FÜNF ANGABEN FÜR DIE DATEIBENENNUNG ===

1. "name" = Name der BEILAGE / des beworbenen Produkts (das, was eingelegt wird).
   - Der Werbekunde oder der Kampagnen-/Produktname, z.B. "Netto", "expert Klein", "Heurich Logo Getränke", "OBI Marburg", "bredent", "Biologika", "NeuroUpdate 2026".
   - Nimm den PRODUKT-/KAMPAGNENNAMEN, nicht den Konzern dahinter und nicht den kompletten Objekt-String: "204.16 Switch_Guide Biologika Immunologie_Folder" -> "Biologika"; "Folder Infektio Update 2026, 6-seitig" -> "InfektioUpdate 2026".
   - Gibt es keinen eigenen Kampagnennamen, ist der Werbekunde der Name, z.B. "Roche", "Pfizer", "DGK Akademie".
   - NIEMALS eine Trägerzeitung aus der Liste oben.
   - NIEMALS der Name der DRUCKEREI oder SPEDITION (Absender). Ignoriere Firmen wie: Mohn Media / Mohndruck, Jungfer Druckerei, EuroPrintPartner, Wittich, Severotisk, appl druck, bauerprint, Druckpress, COLOR+, pt print, atrikom fulfillment, Radin-Berger, Schmidt Ley, Baumann, JD Druck, OSFAL, Weiss, Waitkewitsch, Wecom, phase5, DHL, S&P.
   - NIEMALS der EMPFÄNGER (immer "ColdsetInnovation Fulda" - das sind WIR, ignorieren). Auch Ansprechpartner-Namen (z.B. "Frau Carmen Seeling") ignorieren.
   - Kurz und knapp halten.

2. "version" = Versions-/Variantenkennzeichen der Beilage, falls vorhanden.
   - z.B. "V10", "V001", "Logo Getränke 29/26", "Version 1", ein KZ wie "C"/"A", oder eine KW-Angabe wie "KW29-26".
   - Wenn keine klare Version erkennbar: null.

3. "stueckzahl" = GESAMT-Stückzahl der ganzen Lieferung (alle Paletten zusammen).
   - Achte auf "Gesamtmenge", "Menge", "Ges", "Quantity", "Auflage (Ges)", "Gesamt", "geliefert", "Liefermenge", "Stückzahl lt. Lieferschein".
   - Bei mehreren Paletten die GESAMTsumme, NICHT die Einzelpalette. Beispiel: "39.000 / 102.000" -> 102000.
   - TEILMENGEN ADDIEREN: Steht "3.400 Exemplare + 100 Ex.", ist die Gesamtmenge 3500. Niemals nur die erste Zahl nehmen.
   - Wenn "Inhalt" und "Gesamtmenge" beide dastehen, nimm "Gesamtmenge".
   - Ungefähr-Angaben wie "ca. 19000" ohne das "ca." übernehmen.
   - Nur die reine Zahl OHNE Tausenderpunkte und ohne Einheit (z.B. "3011", "102000", "3500").

4. "et" = Erscheinungstermin bzw. Ausgabe der Trägerzeitung.
   - Begriffe: "ET", "Erscheinungstermin", "Liefertermin", "Streutermin", "Beilegetermin", "lt. Lieferschein", "Issue", "Heft-Nr.", "publ. date", "Verteilung", "Datum".
   - Das kann ein DATUM sein ("15.07.2026") ODER ein AUSGABEN-/HEFTCODE ("CN 04/26", "ZA 5/26", "1-4/26", "3/26", "Heft-Nr. 01/26"). Beides ist gültig - übernimm die Angabe wie im Dokument.
   - Enthält der Code ein Zeitungskürzel, gehört das Kürzel zusätzlich nach "zeitung": "CN 04/26" -> et="04/26", zeitung="CN".
   - Bevorzuge das VERÖFFENTLICHUNGS-/Erscheinungsdatum, NICHT das Anlieferdatum ("angeliefert am").
   - Wenn nicht erkennbar: null.

5. "zeitung" = Kürzel der Trägerzeitung laut Liste oben.
   - Nur das Kürzel ausgeben: FZ, MK, BW, ÄW, CN, ZA, RH, SB, KN oder HZ.
   - Nicht gelistete Zeitung oder unklar: null.

=== ALLGEMEINE REGELN ===
- HANDSCHRIFT SCHLÄGT DRUCK: Ist ein gedruckter Wert handschriftlich durchgestrichen, überschrieben oder daneben korrigiert, gilt die HANDSCHRIFTLICHE Angabe. Beispiel: gedruckt "ID 2126", handschriftlich "2141" daneben -> 2141 gilt.
- Wenn du dir bei einem Wert nicht sicher bist, gib null zurück - lieber ein leeres Feld, das der Mensch ergänzt, als eine falsche Rate-Angabe.
- Gib den Druckerei-/Speditionsnamen NIEMALS als "name" aus.
- Gib eine Trägerzeitung NIEMALS als "name" aus.

Antworte NUR mit reinem JSON, kein Markdown, keine Erklärung:
{"name":string|null,"version":string|null,"stueckzahl":string|null,"et":string|null,"zeitung":string|null}`;

    const content = images.map(b64 => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
    }));
    content.push({ type: 'text', text: prompt });

    let apiRes;
    try {
      apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1000, messages: [{ role: 'user', content }] }),
      });
    } catch { return json({ error: 'Anthropic nicht erreichbar.' }, 502, cors); }

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      return json({ error: 'API-Fehler', status: apiRes.status, detail }, apiRes.status, cors);
    }

    const data = await apiRes.json();
    const text = (data.content || [])
      .filter(c => c.type === 'text').map(c => c.text).join('')
      .replace(/```json|```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(text); } catch { return json({ error: 'Antwort nicht parsebar.', raw: text }, 502, cors); }

    return json({
      name: parsed.name ?? null,
      version: parsed.version ?? null,
      stueckzahl: parsed.stueckzahl != null ? String(parsed.stueckzahl) : null,
      et: parsed.et ?? null,
      zeitung: parsed.zeitung ?? null,
    }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
