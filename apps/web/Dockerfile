FROM nginx:1.30.4-alpine@sha256:02b1b2a0445514891a14aa371845f6085d5d9d10d385b30d6aad606a50a29a05
COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/dist/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
