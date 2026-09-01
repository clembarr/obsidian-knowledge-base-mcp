---
# Identité du projet
title: "Serveur domotique"
status: "en cours"
created: 2026-06-14
last_session: 2026-08-28
tags: [domotique, self-hosted, rpi]

# Avancement
progress: "60%"
current_phase: "Phase 2 — Automatisations"
next_step: "Écrire l'automatisation de coupure du chauffe-eau en heures pleines"

# Contexte clé
summary: "Home Assistant auto-hébergé sur un Raspberry Pi 5, pour piloter chauffage et volets sans cloud."
stack: [Home Assistant, Zigbee2MQTT, Raspberry Pi 5, Docker]
sources:
  - https://www.home-assistant.io/docs/
  - "[[Zigbee — notes de compatibilité]]"

# Suivi des problématiques
open_issues:
  - "Le capteur de température du salon décroche toutes les 48h"
  - "Pas encore de stratégie de sauvegarde de la config"
resolved_issues:
  - "Choix du dongle Zigbee (SkyConnect retenu)"
  - "Docker vs installation native"

# Meta
claude_project: true
session_count: 3

# Clé perso ajoutée à la main — doit survivre aux écritures du MCP
budget: "230 €"
---

## 🎯 Vision

> Reprendre le contrôle du chauffage et des volets sans dépendre d'un cloud
> propriétaire. Tout doit continuer à fonctionner si la box internet tombe.

---

## ✅ Décisions validées

- [2026-06-14] Home Assistant OS plutôt que HA Container — mises à jour plus simples
- [2026-06-27] Zigbee plutôt que Z-Wave : matériel moins cher et mieux dispo
- [2026-07-19] Dongle SkyConnect, flashé en firmware Zigbee
- [2026-08-28] Les automatisations vivent en YAML versionné, pas dans l'UI

---

## 🏗️ Architecture / Design actuel

```
[Capteurs Zigbee] → SkyConnect → Zigbee2MQTT → MQTT → Home Assistant
                                                          ↓
                                                   [Volets, chauffage]
```

| Composant     | Rôle                  | État        |
| ------------- | --------------------- | ----------- |
| Raspberry Pi 5| Hôte                  | ✅ en place |
| Zigbee2MQTT   | Pont radio            | ✅ en place |
| Mosquitto     | Broker MQTT           | ✅ en place |
| Node-RED      | Automatisations riches| ⏳ à évaluer|

> [!warning] Le Pi tourne sur carte SD — à migrer sur SSD avant la mise en prod.

---

## 📋 Journal des sessions

### Session 1 — 2026-06-14

> Cadrage. On a arbitré HA OS contre HA Container, et listé les pièces à équiper
> en priorité (salon, chambre, bureau).

### Session 2 — 2026-07-19

> Réception du dongle. Flash du firmware Zigbee, appairage des trois premiers
> capteurs. Le capteur du salon a déjà décroché une fois — à surveiller.

### Session 3 — 2026-08-28

> Passage des automatisations de l'UI vers du YAML versionné dans un dépôt git.
> Résolu le choix Docker/natif au passage.

---

## ❓ Questions ouvertes

- Faut-il ajouter Node-RED ou les automatisations YAML suffisent-elles ?
- Comment gérer les sauvegardes hors-site sans cloud tiers ?
