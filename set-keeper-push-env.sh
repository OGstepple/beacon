#!/usr/bin/env bash
# Copies the two Pushover keys from ~/.claude/.env onto the Beacon Netlify site (functions scope),
# then redeploys so /api/leave can buzz the keeper's phone. Run by George, not by an agent.
set -euo pipefail
source "$HOME/.claude/.env"
SITE=a2e85a7a-404c-486e-8ffb-50a83e7944f6
cd "$(dirname "$0")"
NT=$(python3 -c "import json,os;c=json.load(open(os.path.expanduser('~/Library/Preferences/netlify/config.json')));print(c['users'][c['userId']]['auth']['token'])")
ACCT=$(curl -fsS -H "Authorization: Bearer $NT" "https://api.netlify.com/api/v1/sites/$SITE" | python3 -c "import json,sys;print(json.load(sys.stdin)['account_id'])")
for K in PUSHOVER_APP_TOKEN PUSHOVER_USER_KEY; do
  V="${!K}" K="$K" python3 -c "import json,os;print(json.dumps([{'key':os.environ['K'],'scopes':['functions'],'values':[{'context':'all','value':os.environ['V']}]}]))" |
  curl -s -o /dev/null -w "$K -> %{http_code}\n" -X POST -H "Authorization: Bearer $NT" -H "Content-Type: application/json" --data @- "https://api.netlify.com/api/v1/accounts/$ACCT/env?site_id=$SITE"
done
netlify deploy --prod --site "$SITE" --dir site --functions netlify/functions
