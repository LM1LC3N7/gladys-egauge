# Compteur eGauge

Intégration **non officielle**, sans lien avec eGauge Systems. Elle lit un
**compteur d'énergie eGauge** (EG4xxx, EG30xx avec un firmware qui offre la
WebAPI) par sa **WebAPI officielle**, en HTTPS sur votre réseau domestique,
sans cloud. **Lecture seule** : le compteur n'est jamais commandé ni
configuré (les services `/api/cmd` — redémarrage, effacement, retour usine —
et `/api/config` ne sont jamais appelés).

**Jamais testé avec un vrai compteur eGauge** : construit d'après la
documentation de la WebAPI (webapi.egauge.net) et la bibliothèque
egauge-python du fabricant (MIT), et testé contre un faux compteur bâti à
partir d'elles.

## Prérequis

- Un compteur eGauge sur votre réseau, joignable depuis Gladys en HTTPS
  (port 443 par défaut) ;
- un compte du compteur (Settings > Access Control dans son interface web).
  Un compte qui peut seulement voir les données suffit (sans le droit
  « View settings », le compteur est identifié par son certificat, voir
  « Identité ») : créez-en un pour
  Gladys plutôt que de donner le compte propriétaire.

## Configuration

- **Adresse du compteur** : son adresse IP (ou son nom d'hôte local), avec
  un port seulement s'il n'est pas 443. Donnez-lui une adresse fixe dans
  votre box.
- **Nom d'utilisateur** et **mot de passe** du compte. Le mot de passe est
  gardé par Gladys dans sa base, jamais réaffiché, et ne quitte jamais
  Gladys : l'intégration se connecte par le condensé de la WebAPI (elle
  prouve qu'elle connaît le mot de passe sans l'envoyer) et reçoit un jeton
  valable une dizaine de minutes. Le nom d'utilisateur, le mot de passe, le
  jeton et le numéro de série du compteur ne sont écrits ni dans les
  journaux, ni dans le statut, ni dans `/data`.
- **Empreinte du certificat** (facultatif) : voir ci-dessous.
- **Registres comptés en consommation** et **en production** (facultatif) :
  les noms exacts de registres, séparés par des virgules, dont l'énergie
  entre dans le suivi énergétique de Gladys. Un registre figure dans une
  liste au plus.

### Le certificat

Le compteur présente un certificat auto-signé, qu'aucune autorité ne garantit.
**Rien n'est envoyé au compteur tant que vous n'avez pas confirmé son
certificat** : à la première lecture, l'intégration fait seulement la
négociation TLS et affiche dans le statut l'empreinte SHA-256 rencontrée.
Ouvrez `https://<adresse du compteur>` dans votre navigateur, affichez le
certificat et comparez son empreinte SHA-256, puis :

- cliquez sur **Faire confiance au certificat** : le premier clic relit le
  certificat (une négociation TLS, rien d'envoyé) et donne son empreinte ; le
  second, de 3 secondes à 5 minutes plus tard, l'accepte si le compteur
  présente toujours le même ; l'empreinte est gardée dans `/data` ;
- ou copiez l'empreinte dans le champ **Empreinte du certificat** et
  enregistrez : c'est alors elle qui fait foi.

Si le certificat change plus tard (compteur remplacé ou réinitialisé), plus
rien n'est envoyé et le statut affiche la nouvelle empreinte : il n'est
jamais réappris tout seul, vous le confirmez de la même façon. La
vérification par autorité est coupée pour les seules requêtes vers le
compteur (l'empreinte décide à sa place), jamais pour tout le module.

Ouvrez ensuite l'onglet **Découverte** et créez les registres voulus.

## Ce que vous obtenez

Un appareil par registre d'un type pris en charge, lu toutes les 30 secondes :

- **Registre de puissance** (type P : circuits, solaire, réseau) :
  - non listé : sa **puissance** (W, signée comme le compteur la donne,
    simple capteur) ; pour un registre dont le nom finit par `+`, `-` ou `|`,
    son **énergie cumulée** (kWh, simple capteur, non comptée) ;
  - listé en consommation : **puissance de consommation** (W) et **index de
    consommation** (kWh) ; le suivi énergétique de Gladys en tire la
    consommation par demi-heure (la fonction 30 minutes est déclarée avec
    lui, Gladys la remplit) ;
  - listé en production : **puissance de production** (W, la veille d'un
    onduleur la nuit est affichée 0) et **index de production** (kWh), avec
    sa production par demi-heure.
- **Tension** (V), **courant** (A), **fréquence** (Hz) et **température**
  (°C) des registres de ces types.

Une valeur hors des bornes déclarées à Gladys (puissance au-delà de
±10 MW, température hors de −100 à 1000 °C...) n'est pas une mesure : elle
n'est pas publiée. Un registre listé qui ne compte rien (pas de puissance,
ou énergie cumulée nulle ou négative) est signalé dans le statut.

Les autres types (humidité, débit, irradiance...) ne sont pas proposés (le
statut les compte).

### Quels registres lister ?

Le compteur accumule chaque registre en W·s. Le suffixe d'un registre
physique dit ce qu'il accumule : `+` la puissance positive seulement, `-` la
puissance négative seulement (affichée ici avec le signe inversé : ce qui a
été exporté), `|` la valeur absolue ; sans suffixe, la puissance **nette**,
qui peut monter et descendre. Un registre net non listé n'a donc pas
d'énergie dans Gladys : une valeur nette qui baisse n'est pas un compteur.

Typiquement :

- en consommation, la consommation totale de la maison (le registre virtuel
  souvent nommé `use`) et, si vous voulez les suivre, des circuits ;
- en production, le solaire (`gen`, `Solar+`...) ;
- pour le réseau, préférez des registres `Grid+` (achat) et `Grid-` (vente)
  créés dans le compteur plutôt que `Grid` net.

Une valeur lue est celle du compteur depuis la création de sa base (`raw`) :
changer l'« époque » dans le compteur ne la fait pas baisser.

### Compteurs cumulés

Chaque énergie cumulée (index ou simple capteur) passe par une garde : jamais
0, et une **baisse** ou un **saut** impossible n'est jamais publié tout seul,
ni confirmé par le temps. La valeur est **retenue** (la dernière bonne reste),
le statut l'affiche et l'appareil prend un badge orange. Si c'est juste
(compteur remplacé, registre remis à zéro), cliquez deux fois sur **Accepter
les valeurs retenues** (de 3 secondes à 5 minutes d'écart) : un saut accepté
est compté d'un coup, une baisse acceptée ne compte rien et le compteur
repart de là. Enregistrer la configuration n'accepte jamais. Un registre net
listé qui baisse de 0,2 kWh au plus (la veille d'un onduleur la nuit) n'est
ni publié ni retenu : la dernière valeur reste jusqu'à ce qu'il remonte.

### Identité

À chaque lecture, l'intégration lit le numéro de série du compteur et le
compare à celui de la première lecture (une empreinte salée dans `/data`,
jamais le numéro). Un compte sans le droit « View settings » ne peut pas lire
ce numéro : ses registres sont lus quand même, et le compteur est alors
identifié par le certificat que vous avez confirmé (le statut le dit) ; un
nouveau certificat accepté vaut alors « autre compteur » jusqu'à vos deux
clics. Un autre compteur à l'adresse : plus rien n'est publié
tant que vous ne l'acceptez pas (deux clics sur **Accepter les valeurs
retenues**), pour ne jamais mêler ses compteurs à ceux du premier.

## Boutons

- **Tester la connexion** : lit le compteur si une lecture est due (jamais
  plus d'une toutes les 30 secondes), sinon donne la dernière lecture. Après
  une connexion refusée, il réessaie une fois.
- **Faire confiance au certificat** : voir plus haut.
- **Accepter les valeurs retenues** : voir plus haut.

## Ce qui se passe quand...

- **Le compteur refuse le nom d'utilisateur ou le mot de passe** : plus
  rien n'est lu tout seul tant qu'un autre n'est pas enregistré ou que
  **Tester la connexion** ne réussit pas. Un refus d'une lecture juste après
  une connexion réussie (droits du compte) n'est pas un refus du mot de
  passe.
- **Le compteur répond « trop de requêtes » (429) ou une erreur 5xx** : les
  lectures sont en pause, de 1 minute à 6 heures (ou ce que le compteur
  demande), gardée au redémarrage.
- **Le compteur ne répond plus** : nouvel essai après 30 secondes, doublé
  jusqu'à 5 minutes.
- **La dernière ligne du compteur a plus de 2 heures** (horloge du compteur,
  son en-tête `Date`) : rien n'est publié.
- **`/data` ne peut pas être lu** : rien n'est publié ni proposé (le
  compteur ne peut pas être identifié), le bouton ne peut pas faire
  confiance à un certificat (saisissez l'empreinte), le fichier n'est jamais
  écrasé. **`/data` ne peut pas être écrit** : les compteurs cumulés sont
  retenus, et rien n'est publié tant que l'identité du compteur n'y est pas
  gardée (première lecture).

Gladys reçoit au plus 250 valeurs par minute de l'intégration : avec beaucoup
de registres, les appareils passent à tour de rôle.
