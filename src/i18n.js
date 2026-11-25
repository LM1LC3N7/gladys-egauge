// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a free text of the meter: only our own words, error codes, numbers we
// checked, register names (the user's own, checked by src/egauge/model.js)
// and the fingerprint of a certificate met. Never the user name, the
// password, the token nor the serial number of the meter.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  // Rounded first: 59.99 s is told "1 min", never "60 s".
  if (Math.round(ms / 1000) >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** A status is bounded: Gladys shows it in one block. */
const MAX_STATUS = 1500;
const bound = (text) => (text.length > MAX_STATUS ? `${text.slice(0, MAX_STATUS - 1)}…` : text);

/** Our words for an error code of src/egauge/errors.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  http: { en: 'HTTP error', fr: 'erreur HTTP' },
  redirect: {
    en: 'redirect refused (is it the meter?)',
    fr: 'redirection refusée (est-ce bien le compteur ?)',
  },
  server: { en: 'error of the meter', fr: 'erreur du compteur' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  credentials: { en: 'login refused', fr: 'connexion refusée' },
  access: {
    en: 'read refused right after the login (does this account see the registers?)',
    fr: 'lecture refusée juste après la connexion (ce compte voit-il les registres ?)',
  },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  bad_answer: {
    en: 'not an answer of the eGauge WebAPI (is it an eGauge meter with a recent firmware?)',
    fr: 'ce n’est pas une réponse de la WebAPI eGauge (est-ce un compteur eGauge avec un firmware récent ?)',
  },
  tls: { en: 'TLS handshake refused', fr: 'négociation TLS refusée' },
  late: { en: 'configuration changed', fr: 'configuration changée' },
};

export function reason(err) {
  const text = REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server') && Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const num = (value) => Math.round(value * 1000) / 1000;

/** `ago` ms ago, or undefined for a read made by this click. */
const when = (ago) =>
  ago === undefined
    ? { en: 'Read now', fr: 'Lu à l’instant' }
    : { en: `Last read ${delay(ago).en} ago`, fr: `Dernière lecture il y a ${delay(ago).fr}` };

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: bound(join('en', first, notes)),
  fr: bound(join('fr', first, notes)),
});

/** The next read, or nothing when no read is planned (a refused login). */
const nextRead = (next) =>
  next === undefined
    ? { en: '', fr: '' }
    : { en: ` Next read in ${delay(next).en}.`, fr: ` Prochaine lecture dans ${delay(next).fr}.` };

/** The name of a counter (a feature key of src/devices.js). */
const COUNTER = {
  lifetime: { en: 'lifetime energy', fr: 'énergie cumulée' },
  consumption_index: { en: 'consumption index', fr: 'index de consommation' },
  production_index: { en: 'production index', fr: 'index de production' },
};

/** A held counter in words: which, of which register, from and to. */
const heldText = (lang, h) => {
  const name = COUNTER[h.key]?.[lang] ?? h.key;
  if (lang === 'en') {
    return h.direction === 'down'
      ? `${name} of "${h.name}" dropped from ${num(h.from)} to ${num(h.to)} kWh`
      : `${name} of "${h.name}" jumped from ${num(h.from)} to ${num(h.to)} kWh`;
  }
  return h.direction === 'down'
    ? `${name} de « ${h.name} » a baissé de ${num(h.from)} à ${num(h.to)} kWh`
    : `${name} de « ${h.name} » a sauté de ${num(h.from)} à ${num(h.to)} kWh`;
};
const helds = (lang, list) => {
  const shown = list.slice(0, 5).map((h) => heldText(lang, h));
  if (list.length > 5)
    shown.push(lang === 'en' ? `${list.length - 5} more` : `${list.length - 5} autres`);
  return shown.join('; ');
};

const names = (list) => {
  const shown = list.slice(0, 10).map((n) => `"${n}"`);
  if (list.length > 10) shown.push('…');
  return shown.join(', ');
};

export const T = {
  incomplete: {
    en: 'Enter the address of your eGauge meter (its IP address on your network, e.g. 192.168.1.30), a user name and its password.',
    fr: 'Saisissez l’adresse de votre compteur eGauge (son adresse IP sur votre réseau, ex. 192.168.1.30), un nom d’utilisateur et son mot de passe.',
  },
  badAddress: {
    en: 'The meter address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.30).',
    fr: 'L’adresse du compteur n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.30).',
  },
  badAddressHttp: {
    en: 'This integration talks to the meter in HTTPS only: enter its address without "http://".',
    fr: 'Cette intégration ne parle au compteur qu’en HTTPS : saisissez son adresse sans « http:// ».',
  },
  badUsername: {
    en: 'Enter the user name of an account of the meter (as in its web interface), without a line break.',
    fr: 'Saisissez le nom d’utilisateur d’un compte du compteur (comme dans son interface web), sans retour à la ligne.',
  },
  badPassword: {
    en: 'Enter the password of that account: it is empty, holds a line break or a control character, or is too long.',
    fr: 'Saisissez le mot de passe de ce compte : il est vide, contient un retour à la ligne ou un caractère de contrôle, ou il est trop long.',
  },
  badFingerprint: {
    en: 'The certificate fingerprint is not valid: 64 hexadecimal digits (with or without colons), as the status showed it.',
    fr: 'L’empreinte du certificat n’est pas valide : 64 chiffres hexadécimaux (avec ou sans deux-points), tels que le statut l’a affichée.',
  },
  configUnread: (wait) => ({
    en: `The configuration could not be read from Gladys: tried again in ${delay(wait).en}.`,
    fr: `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${delay(wait).fr}.`,
  }),
  badgeHeld: {
    en: 'A lifetime counter is held back (see the integration status).',
    fr: 'Un compteur cumulé est retenu (voir le statut de l’intégration).',
  },
  refused: (address, notes) =>
    withNotes(
      {
        en: `The meter at ${address} refuses the user name or the password: nothing is read until another one is saved or the "Test the connection" button succeeds.`,
        fr: `Le compteur à ${address} refuse le nom d’utilisateur ou le mot de passe : plus rien n’est lu tant qu’un autre n’est pas enregistré ou que le bouton « Tester la connexion » ne réussit pas.`,
      },
      notes,
    ),
  paused: (address, pause, left, notes) =>
    withNotes(
      {
        en: `The meter at ${address} answered ${pause.code === 'rate_limited' ? '"too many requests"' : `an error${pause.status ? ` ${pause.status}` : ''}`}: reads paused for ${delay(left).en}.`,
        fr: `Le compteur à ${address} a répondu ${pause.code === 'rate_limited' ? '« trop de requêtes »' : `une erreur${pause.status ? ` ${pause.status}` : ''}`} : lectures en pause pendant ${delay(left).fr}.`,
      },
      notes,
    ),
  certificate: (address, seen, { typed, pinned }, notes) => {
    const how = {
      en: `Check it against the certificate your browser shows at https://${address}, then click "Trust the certificate" twice, or copy it into the "Certificate fingerprint" field and save:`,
      fr: `Comparez-la au certificat que votre navigateur affiche sur https://${address}, puis cliquez deux fois sur « Faire confiance au certificat », ou copiez-la dans le champ « Empreinte du certificat » et enregistrez :`,
    };
    let first;
    if (typed) {
      first = {
        en: `The certificate of the meter at ${address} is not the fingerprint typed: nothing sent. Certificate met: ${seen}.`,
        fr: `Le certificat du compteur à ${address} n’est pas l’empreinte saisie : rien envoyé. Certificat rencontré : ${seen}.`,
      };
    } else if (pinned) {
      first = {
        en: `The certificate of the meter at ${address} is not the one you trusted: nothing sent (the login never goes to an unknown certificate). If you replaced or reset the meter: ${how.en} ${seen}.`,
        fr: `Le certificat du compteur à ${address} n’est pas celui auquel vous avez fait confiance : rien envoyé (la connexion ne part jamais vers un certificat inconnu). Si vous avez remplacé ou réinitialisé le compteur : ${how.fr} ${seen}.`,
      };
    } else {
      first = {
        en: `The meter at ${address} shows a self-signed certificate: nothing is sent until you confirm it. ${how.en} ${seen}.`,
        fr: `Le compteur à ${address} présente un certificat auto-signé : rien n’est envoyé tant que vous ne l’avez pas confirmé. ${how.fr} ${seen}.`,
      };
    }
    return withNotes(first, notes);
  },
  unreachable: (address, err, wait, notes) =>
    withNotes(
      {
        en: `The meter at ${address} could not be read (${reason(err).en}): next try in ${delay(wait).en}.`,
        fr: `Le compteur à ${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  otherMeter: (address, notes) =>
    withNotes(
      {
        en: `Another eGauge meter answers at ${address} (another serial number): nothing is published, so that its counters are never mixed with the first one's. If you replaced the meter, click "Accept the held values" twice.`,
        fr: `Un autre compteur eGauge répond à ${address} (autre numéro de série) : rien n’est publié, pour ne jamais mêler ses compteurs à ceux du premier. Si vous avez remplacé le compteur, cliquez deux fois sur « Accepter les valeurs retenues ».`,
      },
      notes,
    ),
  noIdentity: (address, notes) =>
    withNotes(
      {
        en: `The meter at ${address} answers, but its serial number could not be checked: nothing is published from this read.`,
        fr: `Le compteur à ${address} répond, mais son numéro de série n’a pas pu être vérifié : rien n’est publié de cette lecture.`,
      },
      notes,
    ),
  ok: (address, count, notes) =>
    withNotes(
      {
        en: `Connected to the eGauge meter at ${address}: ${count} register(s).`,
        fr: `Connecté au compteur eGauge à ${address} : ${count} registre(s).`,
      },
      notes,
    ),
  waiting: (address, notes) =>
    withNotes(
      {
        en: `Waiting for the first read of the meter at ${address}.`,
        fr: `En attente de la première lecture du compteur à ${address}.`,
      },
      notes,
    ),
  notes: {
    storeUnreadable: (code) => ({
      en: `/data cannot be read (${code}): nothing published (the meter cannot be identified), no certificate trusted by the button, until it reads again.`,
      fr: `/data ne peut pas être lu (${code}) : rien n’est publié (le compteur ne peut pas être identifié), aucun certificat accepté par le bouton, jusqu’à ce qu’il se lise à nouveau.`,
    }),
    saveFailed: {
      en: '/data cannot be written: the lifetime counters are held back.',
      fr: '/data ne peut pas être écrit : les compteurs cumulés sont retenus.',
    },
    badLists: (code) =>
      code === 'both'
        ? {
            en: 'A register is in both the consumption and the production lists: no register is counted until you fix them.',
            fr: 'Un registre est à la fois dans la liste de consommation et dans celle de production : aucun registre n’est compté tant que vous ne les corrigez pas.',
          }
        : {
            en: 'The consumption or production list is not valid (register names separated by commas): no register is counted until you fix it.',
            fr: 'La liste de consommation ou de production n’est pas valide (noms de registres séparés par des virgules) : aucun registre n’est compté tant que vous ne la corrigez pas.',
          },
    held: (list) => ({
      en: `Held back, never counted without you: ${helds('en', list)}. If it is right (a meter replaced, a register reset), click "Accept the held values" twice.`,
      fr: `Retenu, jamais compté sans vous : ${helds('fr', list)}. Si c’est juste (compteur remplacé, registre remis à zéro), cliquez deux fois sur « Accepter les valeurs retenues ».`,
    }),
    unsupported: (n) => ({
      en: `${n} register(s) of another type (or with an unusable name): not offered.`,
      fr: `${n} registre(s) d’un autre type (ou au nom inutilisable) : non proposé(s).`,
    }),
    missing: (list) => ({
      en: `Listed but not found on the meter (check the exact names): ${names(list)}.`,
      fr: `Listé(s) mais introuvable(s) sur le compteur (vérifiez les noms exacts) : ${names(list)}.`,
    }),
    uncounted: (list) => ({
      en: `Listed but counted nowhere (not a power register, or no lifetime energy above 0: a reversed clamp, a net register that exports?): ${names(list)}.`,
      fr: `Listé(s) mais compté(s) nulle part (pas un registre de puissance, ou pas d’énergie cumulée au-dessus de 0 : pince inversée, registre net qui exporte ?) : ${names(list)}.`,
    }),
    byCertificate: {
      en: 'This account may not read the serial number of the meter (no "view settings" right): the meter is identified by the certificate you confirmed.',
      fr: 'Ce compte ne peut pas lire le numéro de série du compteur (pas de droit « view settings ») : le compteur est identifié par le certificat que vous avez confirmé.',
    },
    stale: {
      en: 'The latest row of the meter is more than 2 hours old: not published.',
      fr: 'La dernière ligne du compteur a plus de 2 heures : non publiée.',
    },
    noDevice: (n) => ({
      en: `${n} register(s) to create in the "Discover" tab.`,
      fr: `${n} registre(s) à créer dans l’onglet « Découverte ».`,
    }),
  },
  trust: {
    typed: {
      en: 'A fingerprint is typed in the configuration: it is the one trusted. Empty that field and save to use this button.',
      fr: 'Une empreinte est saisie dans la configuration : c’est elle qui fait foi. Videz ce champ et enregistrez pour utiliser ce bouton.',
    },
    storeUnreadable: {
      en: '/data cannot be read: no certificate can be kept. Type its fingerprint in the "Certificate fingerprint" field instead.',
      fr: '/data ne peut pas être lu : aucun certificat ne peut être gardé. Saisissez plutôt son empreinte dans le champ « Empreinte du certificat ».',
    },
    failed: (address, err) => ({
      en: `No certificate could be read from ${address} (${reason(err).en}): nothing trusted.`,
      fr: `Aucun certificat n’a pu être lu à ${address} (${reason(err).fr}) : rien n’est accepté.`,
    }),
    changed: {
      en: 'The configuration changed meanwhile: nothing trusted.',
      fr: 'La configuration a changé entre-temps : rien n’est accepté.',
    },
    already: (fp) => ({
      en: `This certificate is already trusted: ${fp}.`,
      fr: `Ce certificat est déjà accepté : ${fp}.`,
    }),
    confirm: (address, fp, within) => ({
      en: `The meter at ${address} shows the certificate ${fp}. Check it against the one your browser shows at https://${address}; if it is the same, click again within ${delay(within).en} (after 3 s) to trust it.`,
      fr: `Le compteur à ${address} présente le certificat ${fp}. Comparez-le à celui que votre navigateur affiche sur https://${address} ; s’il est identique, cliquez à nouveau dans les ${delay(within).fr} (après 3 s) pour lui faire confiance.`,
    }),
    different: (fp) => ({
      en: `The meter now shows another certificate (${fp}): nothing trusted. Check it, then click again.`,
      fr: `Le compteur présente maintenant un autre certificat (${fp}) : rien n’est accepté. Vérifiez-le, puis cliquez à nouveau.`,
    }),
    unwritable: {
      en: '/data cannot be written: the certificate is not trusted (nothing would keep it). Type its fingerprint in the "Certificate fingerprint" field instead.',
      fr: '/data ne peut pas être écrit : le certificat n’est pas accepté (rien ne le garderait). Saisissez plutôt son empreinte dans le champ « Empreinte du certificat ».',
    },
    done: (fp) => ({
      en: `Certificate trusted: ${fp}. The meter is read at the next turn.`,
      fr: `Certificat accepté : ${fp}. Le compteur est lu au prochain tour.`,
    }),
  },
  accept: {
    nothing: {
      en: 'Nothing is held back: nothing to accept.',
      fr: 'Rien n’est retenu : rien à accepter.',
    },
    confirm: (list, other, within) => {
      const items = (lang) => {
        const parts = [];
        if (other)
          parts.push(
            lang === 'en' ? 'the new meter at this address' : 'le nouveau compteur à cette adresse',
          );
        if (list.length > 0) parts.push(helds(lang, list));
        return parts.join('; ');
      };
      return {
        en: bound(
          `Held back: ${items('en')}. Click again within ${delay(within).en} (after 3 s) to accept exactly this. A jump accepted is counted at once; a drop accepted counts nothing and the counter goes on from there.`,
        ),
        fr: bound(
          `Retenu : ${items('fr')}. Cliquez à nouveau dans les ${delay(within).fr} (après 3 s) pour accepter exactement cela. Un saut accepté est compté d’un coup ; une baisse acceptée ne compte rien et le compteur repart de là.`,
        ),
      };
    },
    done: (accepted, changed, meter, meterChanged) => {
      const text = (lang) => {
        const parts = [];
        if (meter) parts.push(lang === 'en' ? 'New meter accepted.' : 'Nouveau compteur accepté.');
        if (meterChanged) {
          parts.push(
            lang === 'en'
              ? 'The meter met is not the one listed: not accepted.'
              : 'Le compteur rencontré n’est pas celui listé : non accepté.',
          );
        }
        if (accepted.length > 0) {
          parts.push(
            lang === 'en'
              ? `Accepted, published at the next read: ${helds('en', accepted)}.`
              : `Accepté, publié à la prochaine lecture : ${helds('fr', accepted)}.`,
          );
        }
        if (changed.length > 0) {
          parts.push(
            lang === 'en'
              ? `Changed since the first click, not accepted: ${helds('en', changed)}.`
              : `Changé depuis le premier clic, non accepté : ${helds('fr', changed)}.`,
          );
        }
        return bound(parts.join(' '));
      };
      return { en: text('en'), fr: text('fr') };
    },
  },
  test: {
    slow: {
      en: 'The meter is slow to answer: the result will be in the integration status.',
      fr: 'Le compteur tarde à répondre : le résultat sera dans le statut de l’intégration.',
    },
    notYet: (next, interval) => ({
      en: `No read yet: the first one comes in ${delay(next ?? interval).en}.`,
      fr: `Pas encore de lecture : la première arrive dans ${delay(next ?? interval).fr}.`,
    }),
    reading: ({ registers, powers }, ago, next) => {
      const w = when(ago);
      return {
        en: `${w.en}: ${registers} register(s), ${powers} of them power.${nextRead(next).en}`,
        fr: `${w.fr} : ${registers} registre(s), dont ${powers} de puissance.${nextRead(next).fr}`,
      };
    },
    failed: (address, err, ago, next) => {
      const w = when(ago);
      return {
        en: `${w.en}: the meter at ${address} could not be read (${reason(err).en}).${nextRead(next).en}`,
        fr: `${w.fr} : le compteur à ${address} n’a pas pu être lu (${reason(err).fr}).${nextRead(next).fr}`,
      };
    },
  },
};
