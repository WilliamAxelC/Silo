# Silo ticket relay

Receives bug reports / feature requests from the Silo app and posts them to Discord #silo through the
Cuangbot gateway (Fix / Reject buttons, reply = fix with instructions). The ticket dispatcher
(`tools/ticket-dispatcher`) reads decisions through the internal endpoints and runs the fix agent.

- Public: only `POST /projects/silo/api/tickets` is routed through nginx.
- Internal endpoints need `Authorization: Bearer $RELAY_ADMIN_TOKEN` and are bound to the LAN port only.
- Secrets live in `/home/agent/orca/silo-tickets/relay.env` on docker-host (never in this repo).
- Data: Docker volume `silo-tickets-data` (`/data/tickets.db`, tickets + full event log).

Deploy (from orca, remote Docker context):

    docker build -t silo-tickets:latest server/tickets
    docker rm -f silo-tickets; docker run -d --name silo-tickets --restart unless-stopped \
      --env-file /home/agent/orca/silo-tickets/relay.env -v silo-tickets-data:/data \
      --network ai-nimate_default -p 10.20.20.11:8131:8080 silo-tickets:latest
