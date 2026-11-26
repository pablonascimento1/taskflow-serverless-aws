#!/usr/bin/env bash
# Implanta o TaskFlow inteiro na AWS. Rode no AWS CloudShell, dentro da pasta do projeto:
#   bash scripts/deploy.sh
# Pode ser executado de novo quantas vezes quiser (atualiza o que mudou).
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${DOMAIN:-pablo.grupo-02.sd.ufersa.dev.br}"
STACK="${STACK:-taskflow}"
REGION="${AWS_REGION:-us-east-1}"
SKIP_DOMAIN="${SKIP_DOMAIN:-false}"   # SKIP_DOMAIN=true para implantar sem o domínio próprio

echo "==> Região: $REGION | Stack: $STACK | Domínio: $DOMAIN"

# ---------- 1. Descobre a hosted zone e confere a delegação de DNS ----------
ZONE_ID=""
API_DOMAIN=""
if [ "$SKIP_DOMAIN" != "true" ]; then
  ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" \
    --query "HostedZones[?Name=='${DOMAIN}.'].Id | [0]" --output text | sed 's|/hostedzone/||')
  if [ -z "$ZONE_ID" ] || [ "$ZONE_ID" = "None" ]; then
    echo "!! Hosted zone '$DOMAIN' não encontrada no Route 53. Implantando sem domínio próprio."
    ZONE_ID=""
  else
    echo "==> Hosted zone: $ZONE_ID"
    # Consulta DNS pública via HTTPS (o CloudShell não tem o comando dig)
    PUBLIC_NS=$(curl -s "https://dns.google/resolve?name=${DOMAIN}&type=NS" || true)
    echo "==> NS vistos pela internet: $(echo "$PUBLIC_NS" | grep -o 'ns-[^"]*awsdns[^"]*' | tr '\n' ' ')"
    if ! echo "$PUBLIC_NS" | grep -q awsdns; then
      echo "!! A delegação de DNS ainda não está ativa (a internet não enxerga os NS da sua zona)."
      echo "   O certificado HTTPS não seria validado e o deploy ficaria travado."
      echo "   Peça ao responsável do grupo para criar o registro NS de '$DOMAIN' com:"
      aws route53 get-hosted-zone --id "$ZONE_ID" --query 'DelegationSet.NameServers' --output text | tr '\t' '\n' | sed 's/^/     /'
      echo "   Implantando SEM domínio próprio por enquanto (rode de novo depois)."
      ZONE_ID=""
    fi
  fi
  if [ -n "$ZONE_ID" ]; then API_DOMAIN="api.$DOMAIN"; fi
fi

# ---------- 2. Cria/atualiza toda a infraestrutura (CloudFormation via SAM) ----------
sam deploy \
  --template-file template.yaml \
  --stack-name "$STACK" \
  --region "$REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "ApiDomainName=$API_DOMAIN" "HostedZoneId=$ZONE_ID"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

CLIENT_ID=$(out UserPoolClientId)
API_URL=$(out ApiCustomUrl)
[ "$API_URL" = "None" ] && API_URL=$(out ApiDefaultUrl)
APP_ID=$(out AmplifyAppId)

# ---------- 3. Gera a configuração do frontend ----------
cat > web/config.js <<EOF
// Gerado por scripts/deploy.sh — não edite à mão
window.TASKFLOW_CONFIG = {
  region: "$REGION",
  userPoolClientId: "$CLIENT_ID",
  apiUrl: "$API_URL"
};
EOF
echo "==> web/config.js gerado (API: $API_URL)"

# ---------- 4. Publica o frontend no Amplify Hosting ----------
if [ "$APP_ID" != "None" ]; then
  rm -f /tmp/taskflow-web.zip
  (cd web && zip -qr /tmp/taskflow-web.zip .)
  read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name main \
    --region "$REGION" --query '[jobId, zipUploadUrl]' --output text)
  curl -sSf -X PUT -T /tmp/taskflow-web.zip "$UPLOAD_URL"
  aws amplify start-deployment --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" \
    --region "$REGION" >/dev/null
  echo "==> Frontend enviado ao Amplify (job $JOB_ID)"
fi

echo
echo "================ PRONTO ================"
aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs[].[OutputKey, OutputValue]' --output table
echo "Próximo passo: crie sua conta pelo site e torne-se admin com:"
echo "  bash scripts/make-admin.sh seu-email@exemplo.com"
