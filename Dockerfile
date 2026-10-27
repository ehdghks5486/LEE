# 다른 호스팅(도커 지원 PaaS 등)용. HTTPS 는 호스팅 쪽 프록시에서 처리하는 것을 전제.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
ENV PORT=3000 HOST=0.0.0.0 DB_PATH=/data/blackout.db SECURE_COOKIES=1 SEED_DEMO=0
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
