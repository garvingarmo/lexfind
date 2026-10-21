#!/bin/bash
# Self-repair for the site on cPanel Web Apps. Run by root's cron every minute (and at boot).
#
# If the site doesn't answer on its local port twice in a row, it:
#   1. renames the app folder back if a cPanel update renamed it to *.bak,
#   2. stops cPanel's systemd service for the container (it would otherwise stop the replacement),
#   3. recreates the container with its port published (cPanel updates have dropped it), and
#   4. regenerates that service for the new container, so it restarts the site after a crash or reboot.
# It does nothing while cPanel is deploying the app, or while the site is healthy.
#
# Install (as root):
#   curl -fsSL https://raw.githubusercontent.com/garvingarmo/lexfind/main/scripts/watchdog.sh -o /root/chaldeanlaw-watchdog.sh
#   chmod 700 /root/chaldeanlaw-watchdog.sh
#   (crontab -l 2>/dev/null; echo '* * * * * ALERT_EMAIL=you@example.com /root/chaldeanlaw-watchdog.sh'; echo '@reboot sleep 60; /root/chaldeanlaw-watchdog.sh') | crontab -
# Log: /var/log/chaldeanlaw-watchdog.log

ACCOUNT="${ACCOUNT:-clawadmin}"
APP="${APP:-chaldeanlaw}"
CONTAINER="${CONTAINER:-chaldeanlaw.clawadmin.01}"
DOMAIN="${DOMAIN:-chaldeanlaw.com}"
# The port Apache forwards the domain to (from its cPanel-generated config), so this follows cPanel if it changes.
HOST_PORT="${HOST_PORT:-$(grep -rhoE 'ProxyPass / http://127\.0\.0\.1:[0-9]+/' /etc/apache2/conf.d/userdata/*/2_4/"$ACCOUNT"/"$DOMAIN"/ 2>/dev/null | grep -oE '[0-9]+/$' | tr -d / | head -1)}"
HOST_PORT="${HOST_PORT:-10000}"
APP_PORT="${APP_PORT:-3000}"
IMAGE="${IMAGE:-docker.io/library/node:22}"
LOG="${LOG:-/var/log/chaldeanlaw-watchdog.log}"
BASE="/home/$ACCOUNT/ea-podman.d"
DIR="$BASE/$CONTAINER"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG"; }
healthy() { curl -fsS -m 10 "http://127.0.0.1:$HOST_PORT/healthz" 2>/dev/null | grep -q '"ok":true'; }
as_account() { su -s /bin/bash - "$ACCOUNT" -c "$1"; }
# systemd --user for the account (cPanel runs each container as a user service).
UNIT="container-$CONTAINER.service"
user_systemctl() { as_account "export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemctl --user $1"; }
alert() {
  [ -n "$ALERT_EMAIL" ] && [ -x /usr/sbin/sendmail ] || return 0
  printf 'To: %s\nSubject: [%s] %s\n\n%s\n\nLog: %s on %s\n' "$ALERT_EMAIL" "$APP" "$1" "$2" "$LOG" "$(hostname)" | /usr/sbin/sendmail -t
}

# One run at a time.
exec 9> "/run/$APP-watchdog.lock"
flock -n 9 || exit 0

healthy && exit 0
sleep 20
healthy && exit 0

# Leave cPanel alone while it is deploying.
if uapi --user="$ACCOUNT" --output=json WebApp list 2>/dev/null | grep -q '"status":"deploying"'; then
  log "site down, but cPanel is deploying; waiting"
  exit 0
fi

log "site not answering on 127.0.0.1:$HOST_PORT; repairing"

if [ ! -d "$DIR" ] && [ -d "$DIR.bak" ]; then
  mv "$DIR.bak" "$DIR" && log "renamed $DIR.bak back to $DIR"
fi
if [ ! -f "$DIR/webapp/package.json" ]; then
  log "app folder $DIR/webapp is missing; cannot repair"
  alert "site is down and needs attention" "The app folder $DIR/webapp is missing, so the watchdog could not restart the site."
  exit 1
fi

# cPanel's service tracks the old container; if left running it stops the new one and restarts its own.
user_systemctl "stop $UNIT" >> "$LOG" 2>&1
user_systemctl "reset-failed $UNIT" >> "$LOG" 2>&1
as_account "podman rm -f $CONTAINER" >> "$LOG" 2>&1
as_account "podman run -d --name $CONTAINER -p 127.0.0.1:$HOST_PORT:$APP_PORT --memory=512m \
  --log-driver=k8s-file --log-opt=path=/home/$ACCOUNT/.cpanel/webapp-logs/$APP/app.log --log-opt=max-size=10m \
  -v $DIR/webapp:/app -w /app --env-file $DIR/webapp/.env -e NODE_ENV=production -e PORT=$APP_PORT \
  --entrypoint /bin/sh $IMAGE -c 'npm run start'" >> "$LOG" 2>&1
# Point the service at the new container, the same way cPanel generates it, and let it take over.
as_account "cd ~/.config/systemd/user 2>/dev/null && podman generate systemd --name $CONTAINER --restart-policy=on-failure --restart-sec=5 --start-timeout=70 --stop-timeout=10 > $UNIT.new 2>/dev/null && mv $UNIT.new $UNIT" >> "$LOG" 2>&1
user_systemctl "daemon-reload" >> "$LOG" 2>&1
user_systemctl "start $UNIT" >> "$LOG" 2>&1

for _ in 1 2 3 4 5 6; do
  sleep 10
  if healthy; then
    log "repaired: site is answering again"
    alert "site was down and has been repaired" "The site stopped answering and the watchdog recreated its container. It is up again."
    exit 0
  fi
done
log "repair attempted but the site is still not answering"
alert "site is down and could not be repaired" "The watchdog recreated the container but the site still isn't answering. Check: su -s /bin/bash - $ACCOUNT -c 'podman logs --tail 50 $CONTAINER'"
exit 1
