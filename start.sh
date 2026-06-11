docker stop 9router
docker rm 9router
docker build -t 9router .
docker run -d --name 9router \
  -p 20128:20128 \
  --env-file .env \
  -v "$HOME/.9router-dev:/app/data" \
  -e DATA_DIR=/app/data \
  9router