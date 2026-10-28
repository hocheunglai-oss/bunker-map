# Official Node.js 24 x86_64 Lambda image, Amazon Linux 2023, resolved 2026-10-28.
# The actual Vercel runtime still needs a read-only deployed compatibility smoke.
FROM public.ecr.aws/lambda/nodejs@sha256:5e24cf7b98b54d2d782476d9579f8043c5c30e42d7ef97759a67b2940f696b2d AS builder
USER root
COPY scripts/postgres-runtime/build.sh /opt/fcuno-build/build.sh
COPY scripts/postgres-runtime/create-manifest.mjs /opt/fcuno-build/create-manifest.mjs
COPY scripts/lib/postgres-runtime-bundle.mjs /opt/fcuno-build/postgres-runtime-bundle.mjs
RUN bash /opt/fcuno-build/build.sh

FROM public.ecr.aws/lambda/nodejs@sha256:5e24cf7b98b54d2d782476d9579f8043c5c30e42d7ef97759a67b2940f696b2d AS proof
COPY --from=builder /opt/fcuno-output/postgres /opt/fcuno-runtime/postgres
COPY --from=builder /opt/postgres17 /opt/fcuno-test/postgres
COPY --from=builder /opt/fcuno-test-tls /opt/fcuno-test/tls
COPY scripts/postgres-runtime/native-proof.mjs /opt/fcuno-test/native-proof.mjs
COPY scripts/lib/postgres-runtime-bundle.mjs /opt/fcuno-test/postgres-runtime-bundle.mjs
RUN printf '\nfcunotest:x:10001:10001:Synthetic PostgreSQL test:/tmp:/sbin/nologin\n' >> /etc/passwd \
    && printf '\nfcunotest:x:10001:\n' >> /etc/group
USER 10001:10001
ENTRYPOINT ["/var/lang/bin/node", "/opt/fcuno-test/native-proof.mjs"]

FROM scratch AS artifact
COPY --from=builder /opt/fcuno-output/ /
