#!/bin/bash
# Start the NPC engine and the simulated anglers if they are not running.
cd /root/divemarket
pgrep -f "^node npc/engine.mjs" >/dev/null || CONTRACT_ID=dm21.testnet GAS_FUNDER=${GAS_FUNDER:-divemarket5.testnet} TICK_MS=60000 setsid nohup node npc/engine.mjs >> npc-dm21.log 2>&1 < /dev/null &
pgrep -f "^node sim/anglers.mjs" >/dev/null || CONTRACT_ID=dm21.testnet setsid nohup node sim/anglers.mjs >> sim-anglers.log 2>&1 < /dev/null &
