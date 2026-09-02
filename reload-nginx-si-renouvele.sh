#!/bin/sh
# Recharge nginx apres un renouvellement de certificat.
# Le drapeau est pose par le --deploy-hook de certbot.
F=/opt/stack/certbot/www/.renewed
[ -f "$F" ] || exit 0
docker exec web nginx -s reload && rm -f "$F"
echo "$(date -Is) nginx recharge apres renouvellement" >> /opt/stack/certbot-reload.log
