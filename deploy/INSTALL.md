# Installing this on an EWS Compute instance

What `grocery.ews-web.eu` runs, as deployed on 2026-09-19. It used to be a pm2
process on a shared host; it is its own machine now, under systemd.

A `nano` instance (1 vCPU, 512 MB, 10 GB) on Debian 13 is plenty — this serves
one JSON file over HTTP.

## Packages and files

    apt-get install -y nodejs npm git

    git clone https://github.com/3rik1sbit/grocery-api /opt/grocery-api
    cd /opt/grocery-api && npm install --omit=dev

    useradd --system --home /opt/grocery-api --shell /usr/sbin/nologin grocery
    chown -R grocery:grocery /opt/grocery-api

## The data does not live with the code

    mkdir -p /var/lib/grocery-api
    mv database.json /var/lib/grocery-api/database.json     # if migrating
    chown -R grocery:grocery /var/lib/grocery-api

`DATABASE_PATH` in the unit points there. `server.js` already read that
variable, so no code change was needed — and a `git pull` in `/opt/grocery-api`
can no longer touch the list. The corollary is that restoring a backup into
the code directory restores it into a file nothing reads.

## The key

    /opt/grocery-api/.env    GROCERY_API_KEY=...    chmod 600

Read by the unit as `EnvironmentFile`. Without it the service starts and
rejects everything with 401, which is the right way round: it fails closed.

## Service

    deploy/grocery-api.service -> /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now grocery-api

No nginx in this instance. The EWS **proxy web route** for `grocery` points
straight at port 3000.

    curl -s -o /dev/null -w '%{http_code}\n' https://grocery.ews-web.eu/lists   # 401
    curl -s -o /dev/null -w '%{http_code}\n' -H "X-API-Key: ..." \
         https://grocery.ews-web.eu/lists                                        # 200
    curl -s https://grocery.ews-web.eu/health                          # {"status":"ok"}

## /health

The only route above the key check, and the only one that answers without a
credential. It exists so the uptime monitor does not need a copy of the
production key to ask whether this is alive; it discloses nothing beyond the
verdict.

It reads the database before answering, so `{"status":"ok"}` means the
process is up *and* `DATABASE_PATH` is readable and parses. A 503 means the
process is up and its data is not -- check that `DATABASE_PATH` in the unit
still points at `/var/lib/grocery-api/database.json` and that `grocery` owns
it.

Monitored by `web_grocery` in `~/scripts/log_uptime.sh` on the host.
