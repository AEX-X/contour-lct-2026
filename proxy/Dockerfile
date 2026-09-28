FROM node:22-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

ARG VITE_CONTOUR_DATA_MODE=api
ARG VITE_CONTOUR_API_BASE_URL=/api/v1
ARG VITE_SHOW_DEMO_CREDENTIALS=false
ENV VITE_CONTOUR_DATA_MODE=${VITE_CONTOUR_DATA_MODE} \
    VITE_CONTOUR_API_BASE_URL=${VITE_CONTOUR_API_BASE_URL} \
    VITE_SHOW_DEMO_CREDENTIALS=${VITE_SHOW_DEMO_CREDENTIALS}

# The regular package build also prepares an OpenAI Sites worker. The local
# monolith needs only the browser bundle, so it deliberately runs the two
# relevant steps without requiring frontend/.openai/hosting.json.
RUN npm run typecheck && npx --no-install vite build


FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY proxy/15-generate-self-signed-cert.sh /docker-entrypoint.d/15-generate-self-signed-cert.sh
COPY proxy/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY proxy/snippets/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=frontend-build /frontend/dist/client/ /usr/share/nginx/html/
COPY proxy/swagger/index.html /usr/share/nginx/html/docs/index.html
COPY proxy/swagger/swagger-initializer.js /usr/share/nginx/html/docs-assets/swagger-initializer.js
COPY --from=frontend-build /frontend/node_modules/swagger-ui-dist/swagger-ui.css /usr/share/nginx/html/docs-assets/swagger-ui.css
COPY --from=frontend-build /frontend/node_modules/swagger-ui-dist/swagger-ui-bundle.js /usr/share/nginx/html/docs-assets/swagger-ui-bundle.js
COPY --from=frontend-build /frontend/node_modules/swagger-ui-dist/swagger-ui-standalone-preset.js /usr/share/nginx/html/docs-assets/swagger-ui-standalone-preset.js

# A Windows checkout can convert shell scripts to CRLF. Normalize the files in
# the image so the nginx entrypoint can execute them reliably.
RUN sed -i 's/\r$//' /docker-entrypoint.d/15-generate-self-signed-cert.sh /etc/nginx/templates/default.conf.template /etc/nginx/snippets/security-headers.conf \
    && chmod +x /docker-entrypoint.d/15-generate-self-signed-cert.sh
