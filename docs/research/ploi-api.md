# Ploi API endpoint inventory

> Researched on 2026-09-18 against Ploi's documentation. This is a documentation inventory, not the CLI reference. It uses Ploi's first-party API reference and MCP documentation only. No live API mutations were made.

## Scope and conventions

- **Coverage.** The official sitemap lists 224 API-reference pages under the resource paths, plus the documented [Teapot](https://developers.ploi.io/getting-started/teapot) endpoint. One resource page, [Insight types](https://developers.ploi.io/insights/insight-types), is a type catalogue rather than an HTTP endpoint, leaving **224 endpoint pages, 225 documented operation sections, and 226 route forms**: [Create custom server](https://developers.ploi.io/servers/create-custom-server) documents two operations, while [Laravel Horizon statistics](https://developers.ploi.io/sites/laravel-horizon-statistics) documents both the default route and an optional `/{type}` form. The sitemap is the coverage manifest: [developers.ploi.io/sitemap.xml](https://developers.ploi.io/sitemap.xml).
- **Base URL/authentication.** The base URL is `https://ploi.io/api`; send `Authorization: Bearer {token}`, `Accept: application/json`, and `Content-Type: application/json` as appropriate. The headers guide also says a descriptive `User-Agent` is required. Sources: [URL](https://developers.ploi.io/getting-started/url), [authorization](https://developers.ploi.io/getting-started/authorization), [headers](https://developers.ploi.io/getting-started/headers).
- **Path notation.** Braced segments are logical parameter names. Where the source cURL used a literal example ID/domain, this inventory normalizes it and flags the ambiguity in the notes.
- **Pagination.** A row marked 'yes' has the documented Laravel-style 'data' + 'links' + 'meta' envelope. Follow 'links.next'; the pagination guide documents 'page', 'per_page' (default 15, maximum 50; values above 50 revert to 15), and the query guide documents 'search' for list views. Sources: [pagination](https://developers.ploi.io/getting-started/pagination), [query parameters](https://developers.ploi.io/getting-started/query-parameters). A row marked 'no' does not show that envelope on its endpoint page; this is not an assertion that undocumented query parameters are rejected.
- **Request fields.** 'body' is the JSON field set shown under Required/Optional attributes or parameters; 'query' is shown under query-parameter headings or in the cURL URL. Required/optional status is copied from the page.
- **CLI names.** Each 'Logical CLI' entry is a descriptive name in this repository's vocabulary, not a command. The CLI reaches every operation through `gq ploi api <operation-id>`, whose IDs follow the docs' routes (such as `sites.log-site`), plus the dedicated `gq ploi` commands; the [command reference](../reference/commands.md) is the CLI contract. The CLI's client uses 'https://ploi.io/api', Bearer auth, unwraps 'data' for detail calls, and follows 'links.next' or 'meta.next_page_url'; source: [src/ploi/api-client.mjs](../../src/ploi/api-client.mjs) and [src/ploi/server-client.mjs](../../src/ploi/server-client.mjs).

## aliases

### Create alias

- **Method/path:** `POST /api/servers/{server}/sites/{site}/aliases`
- **Path parameters:** `server`, `site`
- **Request:** body — `aliases (array; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { aliases, count, main } }`
- **Logical CLI:** `gq ploi aliases create-alias`
- **Source:** [Ploi API reference — Create alias](https://developers.ploi.io/aliases/create-alias)

### Delete alias

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/aliases/{alias}`
- **Path parameters:** `server`, `site`, `alias`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { aliases, count, main } }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi aliases delete-alias`
- **Source:** [Ploi API reference — Delete alias](https://developers.ploi.io/aliases/delete-alias)

### List aliases

- **Method/path:** `GET /api/servers/{server}/sites/{site}/aliases`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { aliases, count, main } }`
- **Logical CLI:** `gq ploi aliases list-aliases`
- **Source:** [Ploi API reference — List aliases](https://developers.ploi.io/aliases/list-aliases)

## apps

### Install Nextcloud

- **Method/path:** `POST /api/servers/{server}/sites/{id}/nextcloud`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at } }`
- **Logical CLI:** `gq ploi apps install-nextcloud`
- **Source:** [Ploi API reference — Install Nextcloud](https://developers.ploi.io/apps/install-nextcloud)

### Install Statamic

- **Method/path:** `POST /api/servers/{server}/sites/{id}/statamic`
- **Path parameters:** `server`, `id`
- **Request:** body — `type (string; optional)`, `provider (string; optional)`, `name (string; optional)`, `private (boolean; optional)`, `description (string; optional)`, `installation_type (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, has_repository, zero_downtime_deployment, fastcgi_cache, created_at }, message }`
- **Logical CLI:** `gq ploi apps install-statamic`
- **Source:** [Ploi API reference — Install Statamic](https://developers.ploi.io/apps/install-statamic)

### Install WordPress

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress`
- **Path parameters:** `server`, `id`
- **Request:** body — `create_database (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at } }`
- **Logical CLI:** `gq ploi apps install-wordpress`
- **Source:** [Ploi API reference — Install WordPress](https://developers.ploi.io/apps/install-wordpress)

### Uninstall Nextcloud

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/nextcloud`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at } }`
- **Logical CLI:** `gq ploi apps uninstall-nextcloud`
- **Source:** [Ploi API reference — Uninstall Nextcloud](https://developers.ploi.io/apps/uninstall-nextcloud)

### Uninstall Statamic

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/statamic`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, has_repository, zero_downtime_deployment, fastcgi_cache, created_at }, message }`
- **Logical CLI:** `gq ploi apps uninstall-statamic`
- **Source:** [Ploi API reference — Uninstall Statamic](https://developers.ploi.io/apps/uninstall-statamic)

### Uninstall WordPress

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/wordpress`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at } }`
- **Logical CLI:** `gq ploi apps uninstall-wordpress`
- **Source:** [Ploi API reference — Uninstall WordPress](https://developers.ploi.io/apps/uninstall-wordpress)

## auth-users

### Create auth user

- **Method/path:** `POST /api/servers/{server}/sites/{id}/auth-users`
- **Path parameters:** `server`, `id`
- **Request:** body — `name (string; required)`, `password (string; required)`, `path (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, path, created_at } }`
- **Logical CLI:** `gq ploi auth-users create-auth-user`
- **Source:** [Ploi API reference — Create auth user](https://developers.ploi.io/auth-users/create-auth-user)

### Delete auth user

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/auth-users/{authUserId}`
- **Path parameters:** `server`, `id`, `authUserId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, path, created_at } }`
- **Logical CLI:** `gq ploi auth-users delete-auth-user`
- **Source:** [Ploi API reference — Delete auth user](https://developers.ploi.io/auth-users/delete-auth-user)

### Get auth user

- **Method/path:** `GET /api/servers/{server}/sites/{id}/auth-users/{authUserId}`
- **Path parameters:** `server`, `id`, `authUserId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, path, created_at } }`
- **Logical CLI:** `gq ploi auth-users show-auth-user`
- **Source:** [Ploi API reference — Get auth user](https://developers.ploi.io/auth-users/get-auth-user)

### List auth users

- **Method/path:** `GET /api/servers/{server}/sites/{id}/auth-users`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, name, path, created_at } }`
- **Logical CLI:** `gq ploi auth-users list-auth-users`
- **Source:** [Ploi API reference — List auth users](https://developers.ploi.io/auth-users/list-auth-users)

## certificates

### Activate certificate

- **Method/path:** `POST /api/servers/{server}/sites/{site}/certificates/{certificate}/activate`
- **Path parameters:** `server`, `site`, `certificate`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, domain, type, active, tenant, site_id, site_tenant_id, server_id, expires_at, created_at } }`
- **Logical CLI:** `gq ploi certificates activate-certificate`
- **Source:** [Ploi API reference — Activate certificate](https://developers.ploi.io/certificates/activate-certificate)

### Create certificate

- **Method/path:** `POST /api/servers/{server}/sites/{site}/certificates`
- **Path parameters:** `server`, `site`
- **Request:** body — `type (string; required)`, `certificate (string; required)`, `private (string; optional)`, `force (boolean; optional)`, `additional (object; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, domain, type, site_id, server_id, expires_at, created_at } }`
- **Logical CLI:** `gq ploi certificates create-certificate`
- **Source:** [Ploi API reference — Create certificate](https://developers.ploi.io/certificates/create-certificate)

### Delete certificate

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/certificates/{certificate}`
- **Path parameters:** `server`, `site`, `certificate`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi certificates delete-certificate`
- **Source:** [Ploi API reference — Delete certificate](https://developers.ploi.io/certificates/delete-certificate)

### Download certificate

- **Method/path:** `GET /api/servers/{server}/sites/{site}/certificates/{certificate}/download`
- **Path parameters:** `server`, `site`, `certificate`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ certificate, certificate_path, expires_at }`; **notes:** on-demand execution/retrieval is documented; 422 behavior documented; private key is not returned
- **Logical CLI:** `gq ploi certificates download-certificate`
- **Source:** [Ploi API reference — Download certificate](https://developers.ploi.io/certificates/download-certificate)

### Get certificate

- **Method/path:** `GET /api/servers/{server}/sites/{site}/certificates/{certificate}`
- **Path parameters:** `server`, `site`, `certificate`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, domain, type, active, site_id, server_id, expires_at, created_at } }`
- **Logical CLI:** `gq ploi certificates show-certificate`
- **Source:** [Ploi API reference — Get certificate](https://developers.ploi.io/certificates/get-certificate)

### List certificates

- **Method/path:** `GET /api/servers/{server}/sites/{site}/certificates`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, domain, type, active, site_id, server_id, expires_at, created_at }, links, meta }`
- **Logical CLI:** `gq ploi certificates list-certificates`
- **Source:** [Ploi API reference — List certificates](https://developers.ploi.io/certificates/list-certificates)

## containers

### Container logs

- **Method/path:** `GET /api/servers/{server}/docker/containers/{container}/logs`
- **Path parameters:** `server`, `container`
- **Request:** body — `lines (integer; optional)`; query — `lines=100`
- **Pagination:** no documented pagination envelope
- **Response:** `{ content }`; **notes:** 404 behavior documented
- **Logical CLI:** `gq ploi containers container-logs`
- **Source:** [Ploi API reference — Container logs](https://developers.ploi.io/containers/container-logs)

### Create container

- **Method/path:** `POST /api/servers/{server}/docker/containers`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`, `deploy_script (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ id, status, name, deploy_script, path, last_deploy_at, created_at, type, state }`
- **Logical CLI:** `gq ploi containers create-container`
- **Source:** [Ploi API reference — Create container](https://developers.ploi.io/containers/create-container)

### Delete container

- **Method/path:** `DELETE /api/servers/{server}/docker/containers/{container}`
- **Path parameters:** `server`, `container`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi containers delete-container`
- **Source:** [Ploi API reference — Delete container](https://developers.ploi.io/containers/delete-container)

### Get container

- **Method/path:** `GET /api/servers/{server}/docker/containers/{container}`
- **Path parameters:** `server`, `container`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ id, status, name, deploy_script, path, last_deploy_at, created_at, type, state }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi containers show-container`
- **Source:** [Ploi API reference — Get container](https://developers.ploi.io/containers/get-container)

### Link site

- **Method/path:** `POST /api/servers/{server}/docker/containers/{container}/site/link`
- **Path parameters:** `server`, `container`
- **Request:** body — `site_id (integer; required)`, `port (integer; required)`, `host (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi containers link-site`
- **Source:** [Ploi API reference — Link site](https://developers.ploi.io/containers/link-site)

### List containers

- **Method/path:** `GET /api/servers/{server}/docker/containers`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, name, deploy_script, path, last_deploy_at, created_at, type, state }, links, meta }`
- **Logical CLI:** `gq ploi containers list-containers`
- **Source:** [Ploi API reference — List containers](https://developers.ploi.io/containers/list-containers)

### Start container

- **Method/path:** `POST /api/servers/{server}/docker/containers/{container}/up`
- **Path parameters:** `server`, `container`
- **Request:** body — `flags (array; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi containers start-container`
- **Source:** [Ploi API reference — Start container](https://developers.ploi.io/containers/start-container)

### Stop container

- **Method/path:** `POST /api/servers/{server}/docker/containers/{container}/down`
- **Path parameters:** `server`, `container`
- **Request:** body — `flags (array; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi containers stop-container`
- **Source:** [Ploi API reference — Stop container](https://developers.ploi.io/containers/stop-container)

### Unlink site

- **Method/path:** `DELETE /api/servers/{server}/docker/containers/{container}/site/unlink`
- **Path parameters:** `server`, `container`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi containers unlink-site`
- **Source:** [Ploi API reference — Unlink site](https://developers.ploi.io/containers/unlink-site)

### Update container

- **Method/path:** `PATCH /api/servers/{server}/docker/containers/{container}`
- **Path parameters:** `server`, `container`
- **Request:** body — `name (string; optional)`, `deploy_script (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ id, status, name, deploy_script, path, last_deploy_at, created_at, type, state }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi containers update-container`
- **Source:** [Ploi API reference — Update container](https://developers.ploi.io/containers/update-container)

## crontabs

### Create crontab

- **Method/path:** `POST /api/servers/{server}/crontabs`
- **Path parameters:** `server`
- **Request:** body — `user (string; required)`, `command (string; required)`, `frequency (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, command, user, frequency, created_at } }`
- **Logical CLI:** `gq ploi crontabs create-crontab`
- **Source:** [Ploi API reference — Create crontab](https://developers.ploi.io/crontabs/create-crontab)

### Delete crontab

- **Method/path:** `DELETE /api/servers/{server}/crontabs/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body
- **Logical CLI:** `gq ploi crontabs delete-crontab`
- **Source:** [Ploi API reference — Delete crontab](https://developers.ploi.io/crontabs/delete-crontab)

### Get crontab

- **Method/path:** `GET /api/servers/{server}/crontabs/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, command, user, frequency, created_at } }`
- **Logical CLI:** `gq ploi crontabs show-crontab`
- **Source:** [Ploi API reference — Get crontab](https://developers.ploi.io/crontabs/get-crontab)

### List crontabs

- **Method/path:** `GET /api/servers/{server}/crontabs`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, command, user, frequency, created_at } }`
- **Logical CLI:** `gq ploi crontabs list-crontabs`
- **Source:** [Ploi API reference — List crontabs](https://developers.ploi.io/crontabs/list-crontabs)

## daemons

### Create daemon

- **Method/path:** `POST /api/servers/{server}/daemons`
- **Path parameters:** `server`
- **Request:** body — `command (string; required)`, `system_user (string; required)`, `processes (integer; required)`, `directory (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, command, processes, system_user, directory, status } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi daemons create-daemon`
- **Source:** [Ploi API reference — Create daemon](https://developers.ploi.io/daemons/create-daemon)

### Delete daemon

- **Method/path:** `DELETE /api/servers/{server}/daemons/{daemon}`
- **Path parameters:** `server`, `daemon`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body
- **Logical CLI:** `gq ploi daemons delete-daemon`
- **Source:** [Ploi API reference — Delete daemon](https://developers.ploi.io/daemons/delete-daemon)

### Get daemon

- **Method/path:** `GET /api/servers/{server}/daemons/{daemon}`
- **Path parameters:** `server`, `daemon`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, command, processes, system_user, directory, status } }`
- **Logical CLI:** `gq ploi daemons show-daemon`
- **Source:** [Ploi API reference — Get daemon](https://developers.ploi.io/daemons/get-daemon)

### List daemons

- **Method/path:** `GET /api/servers/{server}/daemons`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, command, processes, system_user, directory, status }, links, meta }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi daemons list-daemons`
- **Source:** [Ploi API reference — List daemons](https://developers.ploi.io/daemons/list-daemons)

### Pause daemon

- **Method/path:** `POST /api/servers/{server}/daemons/{daemon}/toggle-pause`
- **Path parameters:** `server`, `daemon`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, command, processes, status } }`
- **Logical CLI:** `gq ploi daemons pause-daemon`
- **Source:** [Ploi API reference — Pause daemon](https://developers.ploi.io/daemons/pause-daemon)

### Restart daemon

- **Method/path:** `POST /api/servers/{server}/daemons/{daemon}/restart`
- **Path parameters:** `server`, `daemon`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi daemons restart-daemon`
- **Source:** [Ploi API reference — Restart daemon](https://developers.ploi.io/daemons/restart-daemon)

## database-users

### Attach user to database

- **Method/path:** `POST /api/servers/{server}/databases/{database}/users/attach`
- **Path parameters:** `server`, `database`
- **Request:** body — `user_id (integer; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, user, remote, remote_ip, readonly, created_at } }`; `{ message, errors }`; `{ message }`
- **Logical CLI:** `gq ploi database-users attach-user-to-database`
- **Source:** [Ploi API reference — Attach user to database](https://developers.ploi.io/database-users/attach-user-to-database)

### Create database user

- **Method/path:** `POST /api/servers/{server}/databases/{database}/users`
- **Path parameters:** `server`, `database`
- **Request:** body — `user (string; required)`, `password (string; required)`, `remote (boolean; optional)`, `remote_ip (string; optional)`, `readonly (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, user, remote, remote_ip, readonly, created_at } }`
- **Logical CLI:** `gq ploi database-users create-database-user`
- **Source:** [Ploi API reference — Create database user](https://developers.ploi.io/database-users/create-database-user)

### Delete database user

- **Method/path:** `DELETE /api/servers/{server}/databases/{database}/users/{user}`
- **Path parameters:** `server`, `database`, `user`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body
- **Logical CLI:** `gq ploi database-users delete-database-user`
- **Source:** [Ploi API reference — Delete database user](https://developers.ploi.io/database-users/delete-database-user)

### Get database user

- **Method/path:** `GET /api/servers/{server}/databases/{database}/users/{user}`
- **Path parameters:** `server`, `database`, `user`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, user, remote, remote_ip, readonly, created_at } }`
- **Logical CLI:** `gq ploi database-users show-database-user`
- **Source:** [Ploi API reference — Get database user](https://developers.ploi.io/database-users/get-database-user)

### List database users

- **Method/path:** `GET /api/servers/{server}/databases/{database}/users`
- **Path parameters:** `server`, `database`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, user, remote, remote_ip, readonly, created_at }, links, meta }`
- **Logical CLI:** `gq ploi database-users list-database-users`
- **Source:** [Ploi API reference — List database users](https://developers.ploi.io/database-users/list-database-users)

## database

### Create database backup

- **Method/path:** `POST /api/backups/database`
- **Path parameters:** —
- **Request:** body — `backup_configuration (integer; required)`, `server (integer; required)`, `databases (array; required)`, `interval (integer; required)`, `table_exclusions (string; optional)`, `locations (string; optional)`, `path (string; optional)`, `keep_backup_amount (integer; optional)`, `custom_name (string; optional)`, `password (string; optional)`, `next_backup_at (string; optional)`, `deleteOnFail (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi database-backups create-database-backup`
- **Source:** [Ploi API reference — Create database backup](https://developers.ploi.io/database/create-database-backup)

### Delete database backup

- **Method/path:** `DELETE /api/backups/database/{databaseBackupId}`
- **Path parameters:** `databaseBackupId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi database-backups delete-database-backup`
- **Source:** [Ploi API reference — Delete database backup](https://developers.ploi.io/database/delete-database-backup)

### Get database backup

- **Method/path:** `GET /api/backups/database/{databaseBackupId}`
- **Path parameters:** `databaseBackupId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, label, type, type_human, path, remote_path, locations, interval, table_exclusions, keep_backup_amount, active, server, database, last_backup_at, created_at } }`
- **Logical CLI:** `gq ploi database-backups show-database-backup`
- **Source:** [Ploi API reference — Get database backup](https://developers.ploi.io/database/get-database-backup)

### List database backups

- **Method/path:** `GET /api/backups/database`
- **Path parameters:** —
- **Request:** body — —; query — `server (integer; optional)`, `site (integer; optional)`, `per_page (integer; optional)`
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, label, type, type_human, path, remote_path, locations, interval, table_exclusions, keep_backup_amount, active, server, database, last_backup_at, created_at }, links, meta }`
- **Logical CLI:** `gq ploi database-backups list-database-backups`
- **Source:** [Ploi API reference — List database backups](https://developers.ploi.io/database/list-database-backups)

### Run database backup

- **Method/path:** `POST /api/backups/database/{databaseBackupId}/run`
- **Path parameters:** `databaseBackupId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi database-backups run-database-backup`
- **Source:** [Ploi API reference — Run database backup](https://developers.ploi.io/database/run-database-backup)

### Update database backup

- **Method/path:** `PATCH /api/backups/database/{id}`
- **Path parameters:** `id`
- **Request:** body — `interval (integer; required)`, `keep_backup_amount (integer; required)`, `deleteOnFail (boolean; optional)`, `custom_name (string; optional)`, `path (string; optional)`, `compression (string; optional)`, `excluded (array; optional)`, `locations (string; optional)`, `next_backup_at (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, path, compression, interval, keep_backup_amount, custom_name, delete_on_fail, excluded, locations, status, last_backup_at, next_backup_at, created_at, server, database, backup_configuration } }`
- **Logical CLI:** `gq ploi database-backups update-database-backup`
- **Source:** [Ploi API reference — Update database backup](https://developers.ploi.io/database/update-database-backup)

## databases

### Acknowledge database

- **Method/path:** `POST /api/servers/{server}/databases/acknowledge`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, name, server_id, status, created_at } }`
- **Logical CLI:** `gq ploi databases acknowledge-database`
- **Source:** [Ploi API reference — Acknowledge database](https://developers.ploi.io/databases/acknowledge-database)

### Create database

- **Method/path:** `POST /api/servers/{server}/databases`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`, `user (string; optional)`, `password (string; optional)`, `description (string; optional)`, `site_id (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, name, server_id, status, created_at } }`
- **Logical CLI:** `gq ploi databases create-database`
- **Source:** [Ploi API reference — Create database](https://developers.ploi.io/databases/create-database)

### Delete database

- **Method/path:** `DELETE /api/servers/{server}/databases/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body; irreversible mutation
- **Logical CLI:** `gq ploi databases delete-database`
- **Source:** [Ploi API reference — Delete database](https://developers.ploi.io/databases/delete-database)

### Duplicate database

- **Method/path:** `POST /api/servers/{server}/databases/{database}/duplicate`
- **Path parameters:** `server`, `database`
- **Request:** body — `name (string; required)`, `user (string; optional)`, `password (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, name, server_id, status, created_at }, message }`
- **Logical CLI:** `gq ploi databases duplicate-database`
- **Source:** [Ploi API reference — Duplicate database](https://developers.ploi.io/databases/duplicate-database)

### Forget database

- **Method/path:** `DELETE /api/servers/{server}/databases/{id}/forget`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body
- **Logical CLI:** `gq ploi databases forget-database`
- **Source:** [Ploi API reference — Forget database](https://developers.ploi.io/databases/forget-database)

### Get database

- **Method/path:** `GET /api/servers/{server}/databases/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, name, server_id, status, created_at } }`; `{ data: { id, type, name, server_id, status, site, created_at } }`
- **Logical CLI:** `gq ploi database show`
- **Source:** [Ploi API reference — Get database](https://developers.ploi.io/databases/get-database)

### List databases

- **Method/path:** `GET /api/servers/{server}/databases`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, type, name, server_id, status, created_at }, links, meta }`
- **Logical CLI:** `gq ploi databases list`
- **Source:** [Ploi API reference — List databases](https://developers.ploi.io/databases/list-databases)

## deployments

### Deploy site

- **Method/path:** `POST /api/servers/{server}/sites/{id}/deploy`
- **Path parameters:** `server`, `id`
- **Request:** body — `scheduled (datetime; optional)`, `variables (object; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi deployments deploy-site`
- **Source:** [Ploi API reference — Deploy site](https://developers.ploi.io/deployments/deploy-site)

### Deploy staging site to production

- **Method/path:** `POST /api/servers/{server}/sites/{id}/deploy-to-production`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi deployments deploy-staging-site-to-production`
- **Source:** [Ploi API reference — Deploy staging site to production](https://developers.ploi.io/deployments/deploy-staging-site-to-production)

### Get deploy script

- **Method/path:** `GET /api/servers/{server}/sites/{id}/deploy/script`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ deploy_script }`
- **Logical CLI:** `gq ploi deployments show-deploy-script`
- **Source:** [Ploi API reference — Get deploy script](https://developers.ploi.io/deployments/get-deploy-script)

### Update deploy script

- **Method/path:** `PATCH /api/servers/{server}/sites/{id}/deploy/script`
- **Path parameters:** `server`, `id`
- **Request:** body — `deploy_script (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi deployments update-deploy-script`
- **Source:** [Ploi API reference — Update deploy script](https://developers.ploi.io/deployments/update-deploy-script)

## environment

### Get .env from site

- **Method/path:** `GET /api/servers/{server}/sites/{id}/env`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ content }`
- **Logical CLI:** `gq ploi environment show-env-from-site`
- **Source:** [Ploi API reference — Get .env from site](https://developers.ploi.io/environment/get-env-from-site)

### Update .env from site

- **Method/path:** `PATCH /api/servers/{server}/sites/{id}/env`
- **Path parameters:** `server`, `id`
- **Request:** body — `content (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi environment update-env-from-site`
- **Source:** [Ploi API reference — Update .env from site](https://developers.ploi.io/environment/update-env-from-site)

## fastcgi-cache

### Disable FastCGI cache

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/fastcgi-cache/disable`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, notification_urls, has_repository, zero_downtime_deployment, created_at } }`
- **Logical CLI:** `gq ploi fastcgi-cache disable-fastcgi-cache`
- **Source:** [Ploi API reference — Disable FastCGI cache](https://developers.ploi.io/fastcgi-cache/disable-fastcgi-cache)

### Enable FastCGI cache

- **Method/path:** `POST /api/servers/{server}/sites/{site}/fastcgi-cache/enable`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, notification_urls, has_repository, zero_downtime_deployment, created_at } }`
- **Logical CLI:** `gq ploi fastcgi-cache enable-fastcgi-cache`
- **Source:** [Ploi API reference — Enable FastCGI cache](https://developers.ploi.io/fastcgi-cache/enable-fastcgi-cache)

### Flush FastCGI cache

- **Method/path:** `POST /api/servers/{server}/sites/{site}/fastcgi-cache/flush`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, notification_urls, has_repository, zero_downtime_deployment, created_at } }`
- **Logical CLI:** `gq ploi fastcgi-cache flush-fastcgi-cache`
- **Source:** [Ploi API reference — Flush FastCGI cache](https://developers.ploi.io/fastcgi-cache/flush-fastcgi-cache)

## insights

### Automatically fix insight

- **Method/path:** `POST /api/servers/{server}/insights/{id}/automatically-fix`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, description, log_file, priority, meta, is_fixable, processed_at, created_at } }`; `{ message, errors, links }`
- **Logical CLI:** `gq ploi insights automatically-fix-insight`
- **Source:** [Ploi API reference — Automatically fix insight](https://developers.ploi.io/insights/automatically-fix-insight)

### Delete insight

- **Method/path:** `DELETE /api/servers/{server}/insights/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array, links, meta }`; **notes:** DELETE response is documented with a pagination-shaped empty data envelope; pagination semantics are ambiguous
- **Logical CLI:** `gq ploi insights delete-insight`
- **Source:** [Ploi API reference — Delete insight](https://developers.ploi.io/insights/delete-insight)

### Detail insight

- **Method/path:** `GET /api/servers/{server}/insights/{id}/detail`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, description, description_html, html } }`
- **Logical CLI:** `gq ploi insights detail-insight`
- **Source:** [Ploi API reference — Detail insight](https://developers.ploi.io/insights/detail-insight)

### Get insight

- **Method/path:** `GET /api/servers/{server}/insights/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, status, description, log_file, priority, meta, is_fixable, processed_at, created_at } }`
- **Logical CLI:** `gq ploi insights show-insight`
- **Source:** [Ploi API reference — Get insight](https://developers.ploi.io/insights/get-insight)

### Ignore insight

- **Method/path:** `POST /api/servers/{server}/insights/{id}/ignore`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, description, log_file, priority, meta, is_fixable, processed_at, created_at } }`
- **Logical CLI:** `gq ploi insights ignore-insight`
- **Source:** [Ploi API reference — Ignore insight](https://developers.ploi.io/insights/ignore-insight)

### List insights

- **Method/path:** `GET /api/servers/{server}/insights`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, type, status, description, log_file, priority, meta, is_fixable, processed_at, created_at }, links, meta }`
- **Logical CLI:** `gq ploi insights list-insights`
- **Source:** [Ploi API reference — List insights](https://developers.ploi.io/insights/list-insights)

## load-balancers

### Attach server

- **Method/path:** `PATCH /api/servers/{server}/load-balancer/attach`
- **Path parameters:** `server`
- **Request:** body — `server_id (integer; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{  }`; **notes:** on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi load-balancers attach-server`
- **Source:** [Ploi API reference — Attach server](https://developers.ploi.io/load-balancers/attach-server)

### Detach server

- **Method/path:** `PATCH /api/servers/{server}/load-balancer/detach`
- **Path parameters:** `server`
- **Request:** body — `server_id (integer; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{  }`; **notes:** on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi load-balancers detach-server`
- **Source:** [Ploi API reference — Detach server](https://developers.ploi.io/load-balancers/detach-server)

### Request certificate for domain

- **Method/path:** `POST /api/servers/{server}/load-balancer/{domain}/request-certificate`
- **Path parameters:** `server`, `domain`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi load-balancers request-certificate-for-domain`
- **Source:** [Ploi API reference — Request certificate for domain](https://developers.ploi.io/load-balancers/request-certificate-for-domain)

### Revoke certificate for domain

- **Method/path:** `DELETE /api/servers/{server}/load-balancer/{domain}/revoke-certificate`
- **Path parameters:** `server`, `domain`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi load-balancers revoke-certificate-for-domain`
- **Source:** [Ploi API reference — Revoke certificate for domain](https://developers.ploi.io/load-balancers/revoke-certificate-for-domain)

## monitoring

### Delete monitor

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/monitors/{monitor}`
- **Path parameters:** `server`, `site`, `monitor`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi monitoring delete-monitor`
- **Source:** [Ploi API reference — Delete monitor](https://developers.ploi.io/monitoring/delete-monitor)

### Get monitor

- **Method/path:** `GET /api/servers/{server}/sites/{site}/monitors/{monitor}`
- **Path parameters:** `server`, `site`, `monitor`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, label, location, average_uptime, active, created_at } }`
- **Logical CLI:** `gq ploi monitoring show-monitor`
- **Source:** [Ploi API reference — Get monitor](https://developers.ploi.io/monitoring/get-monitor)

### Get uptime responses

- **Method/path:** `GET /api/servers/{server}/sites/{site}/monitors/{monitor}/uptime-responses`
- **Path parameters:** `server`, `site`, `monitor`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { response_time, created_at } }`
- **Logical CLI:** `gq ploi monitoring show-uptime-responses`
- **Source:** [Ploi API reference — Get uptime responses](https://developers.ploi.io/monitoring/get-uptime-responses)

### List monitors

- **Method/path:** `GET /api/servers/{server}/sites/{site}/monitors`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, label, location, average_uptime, active, created_at }, links, meta }`
- **Logical CLI:** `gq ploi monitoring list-monitors`
- **Source:** [Ploi API reference — List monitors](https://developers.ploi.io/monitoring/list-monitors)

## network-rules

### Create network rule

- **Method/path:** `POST /api/servers/{server}/network-rules`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`, `port (string; required)`, `type (string; required)`, `rule_type (string; required)`, `from_ip_address (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, port, from_ip_address, rule_type, status, created_at } }`
- **Logical CLI:** `gq ploi network-rules create-network-rule`
- **Source:** [Ploi API reference — Create network rule](https://developers.ploi.io/network-rules/create-network-rule)

### Delete network rule

- **Method/path:** `DELETE /api/servers/{server}/network-rules/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body
- **Logical CLI:** `gq ploi network-rules delete-network-rule`
- **Source:** [Ploi API reference — Delete network rule](https://developers.ploi.io/network-rules/delete-network-rule)

### Get network rule

- **Method/path:** `GET /api/servers/{server}/network-rules/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, port, from_ip_address, rule_type, status, created_at } }`
- **Logical CLI:** `gq ploi network-rules show-network-rule`
- **Source:** [Ploi API reference — Get network rule](https://developers.ploi.io/network-rules/get-network-rule)

### List network rules

- **Method/path:** `GET /api/servers/{server}/network-rules`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, name, port, from_ip_address, rule_type, status, created_at } }`
- **Logical CLI:** `gq ploi network-rules list-network-rules`
- **Source:** [Ploi API reference — List network rules](https://developers.ploi.io/network-rules/list-network-rules)

## php

### Disable OPcache

- **Method/path:** `DELETE /api/servers/{server}/disable-opcache`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, type, name, ip_address, internal_ip, ssh_port, reboot_required, php_version, mysql_version, sites_count, monitoring, opcache, installed_php_versions, status_id, created_at } }`
- **Logical CLI:** `gq ploi php disable-opcache`
- **Source:** [Ploi API reference — Disable OPcache](https://developers.ploi.io/php/disable-opcache)

### Enable OPcache

- **Method/path:** `POST /api/servers/{server}/enable-opcache`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, type, name, ip_address, internal_ip, ssh_port, reboot_required, php_version, mysql_version, sites_count, monitoring, opcache, installed_php_versions, status_id, created_at } }`
- **Logical CLI:** `gq ploi php enable-opcache`
- **Source:** [Ploi API reference — Enable OPcache](https://developers.ploi.io/php/enable-opcache)

### Install PHP version

- **Method/path:** `POST /api/servers/{server}/php/install`
- **Path parameters:** `server`
- **Request:** body — `version (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi php install-php-version`
- **Source:** [Ploi API reference — Install PHP version](https://developers.ploi.io/php/install-php-version)

### Installed PHP versions

- **Method/path:** `GET /api/servers/{server}/php/versions`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { versions } }`
- **Logical CLI:** `gq ploi php installed-php-versions`
- **Source:** [Ploi API reference — Installed PHP versions](https://developers.ploi.io/php/installed-php-versions)

### Refresh OPcache

- **Method/path:** `POST /api/servers/{server}/refresh-opcache`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, ip_address, php_version, mysql_version, sites_count, status, created_at } }`
- **Logical CLI:** `gq ploi php refresh-opcache`
- **Source:** [Ploi API reference — Refresh OPcache](https://developers.ploi.io/php/refresh-opcache)

### Switch PHP CLI version

- **Method/path:** `POST /api/servers/{server}/php/cli-version`
- **Path parameters:** `server`
- **Request:** body — `version (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; `{ message, errors, links }`; **notes:** on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi php switch-php-cli-version`
- **Source:** [Ploi API reference — Switch PHP CLI version](https://developers.ploi.io/php/switch-php-cli-version)

## projects

### Create project

- **Method/path:** `POST /api/projects`
- **Path parameters:** —
- **Request:** body — `title (string; required)`, `servers (array; optional)`, `sites (array; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, title, servers, sites, created_at } }`
- **Logical CLI:** `gq ploi projects create-project`
- **Source:** [Ploi API reference — Create project](https://developers.ploi.io/projects/create-project)

### Delete project

- **Method/path:** `DELETE /api/projects/{project}`
- **Path parameters:** `project`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi projects delete-project`
- **Source:** [Ploi API reference — Delete project](https://developers.ploi.io/projects/delete-project)

### Get project

- **Method/path:** `GET /api/projects/{project}`
- **Path parameters:** `project`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, title, servers, sites, created_at } }`
- **Logical CLI:** `gq ploi projects show-project`
- **Source:** [Ploi API reference — Get project](https://developers.ploi.io/projects/get-project)

### List projects

- **Method/path:** `GET /api/projects`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, title, servers, sites, created_at }, links, meta }`
- **Logical CLI:** `gq ploi projects list-projects`
- **Source:** [Ploi API reference — List projects](https://developers.ploi.io/projects/list-projects)

### Update project

- **Method/path:** `PATCH /api/projects/{project}`
- **Path parameters:** `project`
- **Request:** body — `title (string; required)`, `servers (array; optional)`, `sites (array; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, title, servers, sites, created_at } }`
- **Logical CLI:** `gq ploi projects update-project`
- **Source:** [Ploi API reference — Update project](https://developers.ploi.io/projects/update-project)

## queue-workers

### Create queue worker

- **Method/path:** `POST /api/servers/{server}/sites/{id}/queues`
- **Path parameters:** `server`, `id`
- **Request:** body — `connection (string; required)`, `queue (string; required)`, `maximum_seconds (integer; required)`, `sleep (integer; required)`, `processes (integer; required)`, `backoff (integer; required)`, `maximum_tries (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, connection, queue, maximum_seconds, maximum_tries, enviroment, sleep, processes, backoff, status, site_id, server_id } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi queue-workers create-queue-worker`
- **Source:** [Ploi API reference — Create queue worker](https://developers.ploi.io/queue-workers/create-queue-worker)

### Delete queue worker

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/queues/{queueId}`
- **Path parameters:** `server`, `id`, `queueId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi queue-workers delete-queue-worker`
- **Source:** [Ploi API reference — Delete queue worker](https://developers.ploi.io/queue-workers/delete-queue-worker)

### Get queue worker

- **Method/path:** `GET /api/servers/{server}/sites/{id}/queues/{queueId}`
- **Path parameters:** `server`, `id`, `queueId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, connection, queue, maximum_seconds, maximum_tries, enviroment, sleep, processes, backoff, status, site_id, server_id } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi queue-workers show-queue-worker`
- **Source:** [Ploi API reference — Get queue worker](https://developers.ploi.io/queue-workers/get-queue-worker)

### List queue workers

- **Method/path:** `GET /api/servers/{server}/sites/{id}/queues`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, connection, queue, maximum_seconds, maximum_tries, enviroment, sleep, processes, backoff, status, site_id, server_id } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi queue-workers list-queue-workers`
- **Source:** [Ploi API reference — List queue workers](https://developers.ploi.io/queue-workers/list-queue-workers)

### Pause queue worker

- **Method/path:** `POST /api/servers/{server}/sites/{id}/queues/{queueId}/toggle-pause`
- **Path parameters:** `server`, `id`, `queueId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, connection, queue, processes, status } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi queue-workers pause-queue-worker`
- **Source:** [Ploi API reference — Pause queue worker](https://developers.ploi.io/queue-workers/pause-queue-worker)

### Restart queue worker

- **Method/path:** `POST /api/servers/{server}/sites/{id}/queues/{queueId}/restart`
- **Path parameters:** `server`, `id`, `queueId`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi queue-workers restart-queue-worker`
- **Source:** [Ploi API reference — Restart queue worker](https://developers.ploi.io/queue-workers/restart-queue-worker)

## redirects

### Create redirect

- **Method/path:** `POST /api/servers/{server}/sites/{site}/redirects`
- **Path parameters:** `server`, `site`
- **Request:** body — `redirect_from (string; required)`, `redirect_to (string; required)`, `type (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, redirect_from, redirect_to, type } }`
- **Logical CLI:** `gq ploi redirects create-redirect`
- **Source:** [Ploi API reference — Create redirect](https://developers.ploi.io/redirects/create-redirect)

### Delete redirect

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/redirects/{redirect}`
- **Path parameters:** `server`, `site`, `redirect`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi redirects delete-redirect`
- **Source:** [Ploi API reference — Delete redirect](https://developers.ploi.io/redirects/delete-redirect)

### Get redirect

- **Method/path:** `GET /api/servers/{server}/sites/{site}/redirects/{redirect}`
- **Path parameters:** `server`, `site`, `redirect`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, redirect_from, redirect_to, type } }`
- **Logical CLI:** `gq ploi redirects show-redirect`
- **Source:** [Ploi API reference — Get redirect](https://developers.ploi.io/redirects/get-redirect)

### List redirects

- **Method/path:** `GET /api/servers/{server}/sites/{site}/redirects`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, redirect_from, redirect_to, type }, links, meta }`
- **Logical CLI:** `gq ploi redirects list-redirects`
- **Source:** [Ploi API reference — List redirects](https://developers.ploi.io/redirects/list-redirects)

## repositories

### Custom deployment

- **Method/path:** `POST /api/servers/{server}/sites/{site}/repository/custom-deployments`
- **Path parameters:** `server`, `site`
- **Request:** body — `script (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at, repository } }`
- **Logical CLI:** `gq ploi repositories custom-deployment`
- **Source:** [Ploi API reference — Custom deployment](https://developers.ploi.io/repositories/custom-deployment)

### Delete repository

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/repository`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at } }`
- **Logical CLI:** `gq ploi repositories delete-repository`
- **Source:** [Ploi API reference — Delete repository](https://developers.ploi.io/repositories/delete-repository)

### Get repository

- **Method/path:** `GET /api/servers/{server}/sites/{site}/repository`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, quick_deploy, created_at, repository } }`
- **Logical CLI:** `gq ploi repositories show-repository`
- **Source:** [Ploi API reference — Get repository](https://developers.ploi.io/repositories/get-repository)

### Install repository

- **Method/path:** `POST /api/servers/{server}/sites/{site}/repository`
- **Path parameters:** `server`, `site`
- **Request:** body — `provider (string; required)`, `branch (string; required)`, `name (string; required)`, `source_provider_id (integer; optional)`, `install_composer (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, web_directory, wordpress, laravel, project_root, last_deploy_at, created_at, repository } }`
- **Logical CLI:** `gq ploi repositories install-repository`
- **Source:** [Ploi API reference — Install repository](https://developers.ploi.io/repositories/install-repository)

### Toggle quick deploy

- **Method/path:** `POST /api/servers/{server}/sites/{site}/repository/quick-deploy`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, has_repository, zero_downtime_deployment, fastcgi_cache, created_at }, message }`
- **Logical CLI:** `gq ploi repositories toggle-quick-deploy`
- **Source:** [Ploi API reference — Toggle quick deploy](https://developers.ploi.io/repositories/toggle-quick-deploy)

## script-actions

### Create action

- **Method/path:** `POST /api/scripts/{script}/actions`
- **Path parameters:** `script`
- **Request:** body — `trigger (string; required)`, `servers (array; required)`, `delay_seconds (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, trigger, trigger_label, delay_seconds, is_paused, last_triggered_at, servers, created_at, updated_at } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi script-actions create-action`
- **Source:** [Ploi API reference — Create action](https://developers.ploi.io/script-actions/create-action)

### Delete action

- **Method/path:** `DELETE /api/scripts/{script}/actions/{action}`
- **Path parameters:** `script`, `action`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi script-actions delete-action`
- **Source:** [Ploi API reference — Delete action](https://developers.ploi.io/script-actions/delete-action)

### Get action

- **Method/path:** `GET /api/scripts/{script}/actions/{action}`
- **Path parameters:** `script`, `action`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, trigger, trigger_label, delay_seconds, is_paused, last_triggered_at, servers, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-actions show-action`
- **Source:** [Ploi API reference — Get action](https://developers.ploi.io/script-actions/get-action)

### List actions

- **Method/path:** `GET /api/scripts/{script}/actions`
- **Path parameters:** `script`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, script_id, trigger, trigger_label, delay_seconds, is_paused, last_triggered_at, servers, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-actions list-actions`
- **Source:** [Ploi API reference — List actions](https://developers.ploi.io/script-actions/list-actions)

### Rotate webhook secret

- **Method/path:** `POST /api/scripts/{script}/actions/{action}/rotate-secret`
- **Path parameters:** `script`, `action`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, trigger, trigger_label, delay_seconds, is_paused, last_triggered_at, servers, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-actions rotate-action-secret`
- **Source:** [Ploi API reference — Rotate webhook secret](https://developers.ploi.io/script-actions/rotate-action-secret)

### Toggle action

- **Method/path:** `POST /api/scripts/{script}/actions/{action}/toggle`
- **Path parameters:** `script`, `action`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, trigger, trigger_label, delay_seconds, is_paused, last_triggered_at, servers, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-actions toggle-action`
- **Source:** [Ploi API reference — Toggle action](https://developers.ploi.io/script-actions/toggle-action)

### Update action

- **Method/path:** `PATCH /api/scripts/{script}/actions/{action}`
- **Path parameters:** `script`, `action`
- **Request:** body — `trigger (string; required)`, `servers (array; required)`, `delay_seconds (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, trigger, trigger_label, delay_seconds, is_paused, last_triggered_at, servers, created_at, updated_at } }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi script-actions update-action`
- **Source:** [Ploi API reference — Update action](https://developers.ploi.io/script-actions/update-action)

## script-schedules

### Create schedule

- **Method/path:** `POST /api/scripts/{script}/schedules`
- **Path parameters:** `script`
- **Request:** body — `cron_expression (string; required)`, `servers (array; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, cron_expression, servers, is_paused, next_run_at, last_run_at, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-schedules create-schedule`
- **Source:** [Ploi API reference — Create schedule](https://developers.ploi.io/script-schedules/create-schedule)

### Delete schedule

- **Method/path:** `DELETE /api/scripts/{script}/schedules/{schedule}`
- **Path parameters:** `script`, `schedule`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi script-schedules delete-schedule`
- **Source:** [Ploi API reference — Delete schedule](https://developers.ploi.io/script-schedules/delete-schedule)

### Get schedule

- **Method/path:** `GET /api/scripts/{script}/schedules/{schedule}`
- **Path parameters:** `script`, `schedule`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, cron_expression, servers, is_paused, next_run_at, last_run_at, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-schedules show-schedule`
- **Source:** [Ploi API reference — Get schedule](https://developers.ploi.io/script-schedules/get-schedule)

### List schedules

- **Method/path:** `GET /api/scripts/{script}/schedules`
- **Path parameters:** `script`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, script_id, cron_expression, servers, is_paused, next_run_at, last_run_at, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-schedules list-schedules`
- **Source:** [Ploi API reference — List schedules](https://developers.ploi.io/script-schedules/list-schedules)

### Toggle schedule

- **Method/path:** `POST /api/scripts/{script}/schedules/{schedule}/toggle`
- **Path parameters:** `script`, `schedule`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, cron_expression, servers, is_paused, next_run_at, last_run_at, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-schedules toggle-schedule`
- **Source:** [Ploi API reference — Toggle schedule](https://developers.ploi.io/script-schedules/toggle-schedule)

### Update schedule

- **Method/path:** `PATCH /api/scripts/{script}/schedules/{schedule}`
- **Path parameters:** `script`, `schedule`
- **Request:** body — `cron_expression (string; required)`, `servers (array; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, script_id, cron_expression, servers, is_paused, next_run_at, last_run_at, created_at, updated_at } }`
- **Logical CLI:** `gq ploi script-schedules update-schedule`
- **Source:** [Ploi API reference — Update schedule](https://developers.ploi.io/script-schedules/update-schedule)

## scripts

### Create script

- **Method/path:** `POST /api/scripts`
- **Path parameters:** —
- **Request:** body — `label (string; required)`, `user (string; required)`, `content (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, user, label, content, created_at } }`
- **Logical CLI:** `gq ploi scripts create-script`
- **Source:** [Ploi API reference — Create script](https://developers.ploi.io/scripts/create-script)

### Delete script

- **Method/path:** `DELETE /api/scripts/{script}`
- **Path parameters:** `script`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi scripts delete-script`
- **Source:** [Ploi API reference — Delete script](https://developers.ploi.io/scripts/delete-script)

### Get script execution

- **Method/path:** `GET /api/servers/{server}/scripts/run/{execution}`
- **Path parameters:** `server`, `execution`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, server_id, user, content, status, exit_code, output, created_at, started_at, finished_at } }`; **notes:** 404 behavior documented
- **Logical CLI:** `gq ploi scripts show-script-execution`
- **Source:** [Ploi API reference — Get script execution](https://developers.ploi.io/scripts/get-script-execution)

### Get script

- **Method/path:** `GET /api/scripts/{script}`
- **Path parameters:** `script`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, user, label, content, created_at } }`
- **Logical CLI:** `gq ploi scripts show-script`
- **Source:** [Ploi API reference — Get script](https://developers.ploi.io/scripts/get-script)

### List scripts

- **Method/path:** `GET /api/scripts`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, user, label, content, created_at }, links, meta }`
- **Logical CLI:** `gq ploi scripts list-scripts`
- **Source:** [Ploi API reference — List scripts](https://developers.ploi.io/scripts/list-scripts)

### Run one-off script

- **Method/path:** `POST /api/servers/{server}/scripts/run`
- **Path parameters:** `server`
- **Request:** body — `content (string; required)`, `user (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, server_id, user, content, status, exit_code, output, created_at, started_at, finished_at } }`
- **Logical CLI:** `gq ploi scripts run-one-off-script`
- **Source:** [Ploi API reference — Run one-off script](https://developers.ploi.io/scripts/run-one-off-script)

### Run script

- **Method/path:** `POST /api/scripts/{script}/run`
- **Path parameters:** `script`
- **Request:** body — `servers (array; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { running_on_servers } }`
- **Logical CLI:** `gq ploi scripts run-script`
- **Source:** [Ploi API reference — Run script](https://developers.ploi.io/scripts/run-script)

### Update script

- **Method/path:** `PATCH /api/scripts/{script}`
- **Path parameters:** `script`
- **Request:** body — `label (string; optional)`, `user (string; optional)`, `content (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, user, label, content, created_at } }`
- **Logical CLI:** `gq ploi scripts update-script`
- **Source:** [Ploi API reference — Update script](https://developers.ploi.io/scripts/update-script)

## servers

### Create custom server

- **Method/path:** `POST /api/servers/custom`
- **Path parameters:** —
- **Request:** body — `type (string; required)`, `ip (string; required)`, `ssh_port (integer; required)`, `database_type (string; required)`, `php_version (string; required)`, `name (string; optional)`, `os_type (string; optional)`, `description (string; optional)`, `install_monitoring (boolean; optional)`, `webhook_url (url; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ id, name, public_key, ssh_command, start_installation_url, message }`; `{ message }`
- **Logical CLI:** `gq ploi servers create-custom-server`
- **Source:** [Ploi API reference — Create custom server](https://developers.ploi.io/servers/create-custom-server)

### Create custom server

- **Method/path:** `POST /api/servers/custom/{id}/start`
- **Path parameters:** `id`
- **Request:** body — `type (string; required)`, `ip (string; required)`, `ssh_port (integer; required)`, `database_type (string; required)`, `php_version (string; required)`, `name (string; optional)`, `os_type (string; optional)`, `description (string; optional)`, `install_monitoring (boolean; optional)`, `webhook_url (url; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ id, name, public_key, ssh_command, start_installation_url, message }`; `{ message }`
- **Logical CLI:** `gq ploi servers start-installation`
- **Source:** [Ploi API reference — Create custom server](https://developers.ploi.io/servers/create-custom-server)

### Create server

- **Method/path:** `POST /api/servers`
- **Path parameters:** —
- **Request:** body — `plan (string; required)`, `region (string; required)`, `credential (integer; required)`, `type (string; required)`, `database_type (string; required)`, `webserver_type (string; required)`, `php_version (string; required)`, `name (string; optional)`, `os_type (string; optional)`, `description (string; optional)`, `install_monitoring (boolean; optional)`, `ip_type (string; optional)`, `webhook_url (url; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, type, name, ip_address, php_version, mysql_version, sites_count, monitoring, status_id, created_at } }`; `{ message, server }`
- **Logical CLI:** `gq ploi servers create-server`
- **Source:** [Ploi API reference — Create server](https://developers.ploi.io/servers/create-server)

### Delete server

- **Method/path:** `DELETE /api/servers/{server}`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, type, name, ip_address, php_version, mysql_version, sites_count, monitoring, created_at } }`; `{ message, errors, links }`; **notes:** irreversible mutation
- **Logical CLI:** `gq ploi servers delete-server`
- **Source:** [Ploi API reference — Delete server](https://developers.ploi.io/servers/delete-server)

### Get server

- **Method/path:** `GET /api/servers/{id}`
- **Path parameters:** `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, type, name, ip_address, php_version, mysql_version, sites_count, monitoring, created_at } }`
- **Logical CLI:** `gq ploi server show`
- **Source:** [Ploi API reference — Get server](https://developers.ploi.io/servers/get-server)

### List servers

- **Method/path:** `GET /api/servers`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, type, name, ip_address, php_version, mysql_version, sites_count, status, status_id, created_at }, links, meta }`
- **Logical CLI:** `gq ploi servers list`
- **Source:** [Ploi API reference — List servers](https://developers.ploi.io/servers/list-servers)

### Server logs

- **Method/path:** `GET /api/servers/{id}/logs`
- **Path parameters:** `id`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { description, content, site_id, server_id, created_at }, links, meta }`
- **Logical CLI:** `gq ploi servers logs-server`
- **Source:** [Ploi API reference — Server logs](https://developers.ploi.io/servers/logs-server)

### Monitored servers

- **Method/path:** `GET /api/servers/monitored`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, name, ip, url, statistics } }`
- **Logical CLI:** `gq ploi servers monitored`
- **Source:** [Ploi API reference — Monitored servers](https://developers.ploi.io/servers/monitored)

### Server monitoring

- **Method/path:** `GET /api/servers/{server}/monitor`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { cpu, ram, disk, load_average, date } }`; `{ message, errors, links }`
- **Logical CLI:** `gq ploi servers monitoring`
- **Source:** [Ploi API reference — Server monitoring](https://developers.ploi.io/servers/monitoring)

### Restart server

- **Method/path:** `POST /api/servers/{id}/restart`
- **Path parameters:** `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi servers restart-server`
- **Source:** [Ploi API reference — Restart server](https://developers.ploi.io/servers/restart-server)

### Update server

- **Method/path:** `PATCH /api/servers/{server}`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`, `ip (string; optional)`, `ssh_port (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, type, database_type, name, ip_address, internal_ip, ssh_port, reboot_required, php_version, php_cli_version, mysql_version, sites_count, monitoring, opcache, installed_php_versions, updates, description, status_id, provider, created_at, created_human, uptime_human } }`
- **Logical CLI:** `gq ploi servers update-server`
- **Source:** [Ploi API reference — Update server](https://developers.ploi.io/servers/update-server)

## services

### Install WordPress CLI

- **Method/path:** `POST /api/servers/{server}/install/wp-cli`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi services install-wordpress-cli`
- **Source:** [Ploi API reference — Install WordPress CLI](https://developers.ploi.io/services/install-wordpress-cli)

### Reload service

- **Method/path:** `POST /api/servers/{server}/services/{service}/reload`
- **Path parameters:** `server`, `service`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message, fallback }`; **notes:** 422 behavior documented
- **Logical CLI:** `gq ploi services reload-service`
- **Source:** [Ploi API reference — Reload service](https://developers.ploi.io/services/reload-service)

### Restart service

- **Method/path:** `POST /api/servers/{server}/services/{service}/restart`
- **Path parameters:** `server`, `service`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi services restart-service`
- **Source:** [Ploi API reference — Restart service](https://developers.ploi.io/services/restart-service)

### Run WP CLI command

- **Method/path:** `POST /api/servers/{server}/wp-cli/run`
- **Path parameters:** `server`
- **Request:** body — `command (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi services run-wp-cli-command`
- **Source:** [Ploi API reference — Run WP CLI command](https://developers.ploi.io/services/run-wp-cli-command)

### Uninstall WordPress CLI

- **Method/path:** `DELETE /api/servers/{server}/uninstall/wp-cli`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi services uninstall-wordpress-cli`
- **Source:** [Ploi API reference — Uninstall WordPress CLI](https://developers.ploi.io/services/uninstall-wordpress-cli)

## site

### Create site file backup

- **Method/path:** `POST /api/backups/file`
- **Path parameters:** —
- **Request:** body — `backup_configuration (integer; required)`, `server (integer; required)`, `sites (array; required)`, `interval (integer; required)`, `path (object; required)`, `locations (string; optional)`, `keep_backup_amount (integer; optional)`, `custom_name (string; optional)`, `local_path (string; optional)`, `password (string; optional)`, `next_backup_at (string; optional)`, `deleteOnFail (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi site-file-backups create-site-file-backup`
- **Source:** [Ploi API reference — Create site file backup](https://developers.ploi.io/site/create-site-file-backup)

### Delete site file backup

- **Method/path:** `DELETE /api/backups/file/{siteFileBackup}`
- **Path parameters:** `siteFileBackup`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi site-file-backups delete-site-file-backup`
- **Source:** [Ploi API reference — Delete site file backup](https://developers.ploi.io/site/delete-site-file-backup)

### Get site file backup

- **Method/path:** `GET /api/backups/file/{siteFileBackup}`
- **Path parameters:** `siteFileBackup`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, label, type, type_human, path, remote_path, locations, interval, table_exclusions, keep_backup_amount, active, server_id, site, last_backup_at, created_at } }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi site-file-backups show-site-file-backup`
- **Source:** [Ploi API reference — Get site file backup](https://developers.ploi.io/site/get-site-file-backup)

### List site file backups

- **Method/path:** `GET /api/backups/file`
- **Path parameters:** —
- **Request:** body — —; query — `server (integer; optional)`, `site (integer; optional)`, `per_page (integer; optional)`
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, label, type, type_human, path, remote_path, locations, interval, table_exclusions, keep_backup_amount, active, server_id, site, last_backup_at, created_at }, links, meta }`
- **Logical CLI:** `gq ploi site-file-backups list-site-file-backups`
- **Source:** [Ploi API reference — List site file backups](https://developers.ploi.io/site/list-site-file-backups)

### Run site file backup

- **Method/path:** `POST /api/backups/file/{siteFileBackup}/run`
- **Path parameters:** `siteFileBackup`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** the source cURL uses literal backup ID `1`; normalized here
- **Logical CLI:** `gq ploi site-file-backups run-site-file-backup`
- **Source:** [Ploi API reference — Run site file backup](https://developers.ploi.io/site/run-site-file-backup)

### Update site file backup

- **Method/path:** `PATCH /api/backups/file/{siteFileBackup}`
- **Path parameters:** `siteFileBackup`
- **Request:** body — `interval (integer; required)`, `keep_backup_amount (integer; required)`, `path (string; required)`, `deleteOnFail (boolean; optional)`, `custom_name (string; optional)`, `local_path (string; optional)`, `compression (string; optional)`, `excluded (array; optional)`, `locations (string; optional)`, `next_backup_at (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, type, path, local_path, compression, interval, keep_backup_amount, custom_name, delete_on_fail, excluded, locations, status, last_backup_at, next_backup_at, created_at, site, backup_configuration } }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi site-file-backups update-site-file-backup`
- **Source:** [Ploi API reference — Update site file backup](https://developers.ploi.io/site/update-site-file-backup)

## sites

### Change PHP version

- **Method/path:** `POST /api/servers/{server}/sites/{site}/php-version`
- **Path parameters:** `server`, `site`
- **Request:** body — `php_version (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, disable_robots, has_repository, zero_downtime_deployment, has_staging, fastcgi_cache, created_at } }`
- **Logical CLI:** `gq ploi sites change-php-version`
- **Source:** [Ploi API reference — Change PHP version](https://developers.ploi.io/sites/change-php-version)

### Clone site

- **Method/path:** `POST /api/servers/{server}/sites/{site}/clone`
- **Path parameters:** `server`, `site`
- **Request:** body — `clone_to_server (integer; required)`, `domain (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi sites clone-site`
- **Source:** [Ploi API reference — Clone site](https://developers.ploi.io/sites/clone-site)

### Create site

- **Method/path:** `POST /api/servers/{server}/sites`
- **Path parameters:** `server`
- **Request:** body — `root_domain (string; required)`, `web_directory (string; required)`, `project_root (string; optional)`, `project_type (string; optional)`, `system_user (string; optional)`, `webserver_template (integer; optional)`, `webhook_url (url; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, server_id, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, notification_urls, has_repository, created_at } }`; `{ message, server, site }`
- **Logical CLI:** `gq ploi sites create-site`
- **Source:** [Ploi API reference — Create site](https://developers.ploi.io/sites/create-site)

### Delete site

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi sites delete-site`
- **Source:** [Ploi API reference — Delete site](https://developers.ploi.io/sites/delete-site)

### Disable test domain

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/test-domain`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, test_domain, full_test_domain } }`
- **Logical CLI:** `gq ploi sites disable-test-domain`
- **Source:** [Ploi API reference — Disable test domain](https://developers.ploi.io/sites/disable-test-domain)

### Enable test domain

- **Method/path:** `POST /api/servers/{server}/sites/{id}/test-domain`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, test_domain, full_test_domain }, message }`
- **Logical CLI:** `gq ploi sites enable-test-domain`
- **Source:** [Ploi API reference — Enable test domain](https://developers.ploi.io/sites/enable-test-domain)

### Get log site

- **Method/path:** `GET /api/servers/{server}/sites/{id}/log/{log}`
- **Path parameters:** `server`, `id`, `log`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, description, content, type, created_at, created_at_human } }`
- **Logical CLI:** `gq ploi sites show-log-site`
- **Source:** [Ploi API reference — Get log site](https://developers.ploi.io/sites/get-log-site)

### Get NGINX configuration

- **Method/path:** `GET /api/servers/{server}/sites/{site}/nginx-configuration`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ content }`; **notes:** on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi sites show-nginx-configuration`
- **Source:** [Ploi API reference — Get NGINX configuration](https://developers.ploi.io/sites/get-nginx-configuration)

### Get site

- **Method/path:** `GET /api/servers/{server}/sites/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, server_id, status, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, has_repository, quick_deploy, disk_usage, created_at } }`
- **Logical CLI:** `gq ploi site show`
- **Source:** [Ploi API reference — Get site](https://developers.ploi.io/sites/get-site)

### Get test domain

- **Method/path:** `GET /api/servers/{server}/sites/{id}/test-domain`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, domain, test_domain, full_test_domain } }`
- **Logical CLI:** `gq ploi sites show-test-domain`
- **Source:** [Ploi API reference — Get test domain](https://developers.ploi.io/sites/get-test-domain)

### Laravel Horizon statistics

- **Method/path:** `GET /api/servers/{server}/sites/laravel/horizon` (default) or `GET /api/servers/{server}/sites/laravel/horizon/{type}`
- **Path parameters:** `server`; optional `type` — `stats`, `workload`, `masters`, or `failed` (defaults to `stats` when omitted)
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { failedJobs, jobsPerMinute, pausedMasters, periods, processes, queueWithMaxRuntime, queueWithMaxThroughput, recentJobs, status, wait } }`; `{ data: array of { name, length, wait, processes } }`; `{ data: { from-macbook-pro-Ry0f } }`; `{ data: { jobs, total } }`; **notes:** the page's route badge includes `/{type}`, while its default cURL request omits it
- **Logical CLI:** `gq ploi sites laravel-horizon-statistics`
- **Source:** [Ploi API reference — Laravel Horizon statistics](https://developers.ploi.io/sites/laravel-horizon-statistics)

### List sites

- **Method/path:** `GET /api/servers/{server}/sites`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, server_id, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, notification_urls, has_repository, quick_deploy, disk_usage, created_at }, links, meta }`
- **Logical CLI:** `gq ploi sites list`
- **Source:** [Ploi API reference — List sites](https://developers.ploi.io/sites/list-sites)

### Log site

- **Method/path:** `GET /api/servers/{server}/sites/{id}/log`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, description, content, type, created_at, created_at_human }, links, meta }`
- **Logical CLI:** `gq ploi sites log-site`
- **Source:** [Ploi API reference — Log site](https://developers.ploi.io/sites/log-site)

### Reset site permissions

- **Method/path:** `POST /api/servers/{server}/sites/{id}/permission-reset`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, deploy_webhook_url, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, disable_robots, has_repository, zero_downtime_deployment, has_staging, fastcgi_cache, notes, created_at }, message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi sites reset-site-permissions`
- **Source:** [Ploi API reference — Reset site permissions](https://developers.ploi.io/sites/reset-site-permissions)

### Resume site

- **Method/path:** `POST /api/servers/{server}/sites/{id}/resume`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, has_repository, zero_downtime_deployment, fastcgi_cache, created_at } }`
- **Logical CLI:** `gq ploi sites resume-site`
- **Source:** [Ploi API reference — Resume site](https://developers.ploi.io/sites/resume-site)

### Robot access

- **Method/path:** `PATCH /api/servers/{server}/sites/{id}`
- **Path parameters:** `server`, `id`
- **Request:** body — `disable_robots (boolean; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, disable_robots, has_repository, zero_downtime_deployment, has_staging, fastcgi_cache, created_at } }`
- **Logical CLI:** `gq ploi sites robot-access`
- **Source:** [Ploi API reference — Robot access](https://developers.ploi.io/sites/robot-access)

### Suspend site

- **Method/path:** `POST /api/servers/{server}/sites/{id}/suspend`
- **Path parameters:** `server`, `id`
- **Request:** body — `reason (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, server_id, domain, test_domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, has_repository, zero_downtime_deployment, fastcgi_cache, created_at } }`
- **Logical CLI:** `gq ploi sites suspend-site`
- **Source:** [Ploi API reference — Suspend site](https://developers.ploi.io/sites/suspend-site)

### Update NGINX configuration

- **Method/path:** `PATCH /api/servers/{server}/sites/{site}/nginx-configuration`
- **Path parameters:** `server`, `site`
- **Request:** body — `content (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi sites update-nginx-configuration`
- **Source:** [Ploi API reference — Update NGINX configuration](https://developers.ploi.io/sites/update-nginx-configuration)

### Update site

- **Method/path:** `PATCH /api/servers/{server}/sites/{site}`
- **Path parameters:** `server`, `site`
- **Request:** body — `root_domain (string; optional)`, `zero_downtime_deployment (boolean; optional)`, `disable_robots (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, server_id, domain, deploy_script, web_directory, project_type, project_root, last_deploy_at, system_user, php_version, health_url, notification_urls, has_repository, created_at }, message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi sites update-site`
- **Source:** [Ploi API reference — Update site](https://developers.ploi.io/sites/update-site)

## ssh-keys

### Create SSH key

- **Method/path:** `POST /api/servers/{server}/ssh-keys`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`, `key (string; required)`, `system_user (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, name, key, system_user } }`
- **Logical CLI:** `gq ploi ssh-keys create-ssh-key`
- **Source:** [Ploi API reference — Create SSH key](https://developers.ploi.io/ssh-keys/create-ssh-key)

### Delete SSH key

- **Method/path:** `DELETE /api/servers/{server}/ssh-keys/{sshKey}`
- **Path parameters:** `server`, `sshKey`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi ssh-keys delete-ssh-key`
- **Source:** [Ploi API reference — Delete SSH key](https://developers.ploi.io/ssh-keys/delete-ssh-key)

### Get SSH key

- **Method/path:** `GET /api/servers/{server}/ssh-keys/{sshKey}`
- **Path parameters:** `server`, `sshKey`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, status, name, key, system_user } }`
- **Logical CLI:** `gq ploi ssh-keys show-ssh-key`
- **Source:** [Ploi API reference — Get SSH key](https://developers.ploi.io/ssh-keys/get-ssh-key)

### List SSH keys

- **Method/path:** `GET /api/servers/{server}/ssh-keys`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, status, name, key, system_user }, links, meta }`
- **Logical CLI:** `gq ploi ssh-keys list-ssh-keys`
- **Source:** [Ploi API reference — List SSH keys](https://developers.ploi.io/ssh-keys/list-ssh-keys)

## status-pages

### Create status page incident

- **Method/path:** `POST /api/status-pages/{statusPage}/incidents`
- **Path parameters:** `statusPage`
- **Request:** body — `title (string; required)`, `description (string; optional)`, `severity (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, title, description, severity } }`
- **Logical CLI:** `gq ploi status-pages create-status-page-incident`
- **Source:** [Ploi API reference — Create status page incident](https://developers.ploi.io/status-pages/create-status-page-incident)

### Delete status page incident

- **Method/path:** `DELETE /api/status-pages/{statusPage}/incident/{incident}`
- **Path parameters:** `statusPage`, `incident`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ message }`
- **Logical CLI:** `gq ploi status-pages delete-status-page-incident`
- **Source:** [Ploi API reference — Delete status page incident](https://developers.ploi.io/status-pages/delete-status-page-incident)

### Get status page incidents

- **Method/path:** `GET /api/status-pages/{statusPage}/incidents`
- **Path parameters:** `statusPage`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, title, description, severity }, links, meta }`
- **Logical CLI:** `gq ploi status-pages show-status-page-incidents`
- **Source:** [Ploi API reference — Get status page incidents](https://developers.ploi.io/status-pages/get-status-page-incidents)

### Get status page

- **Method/path:** `GET /api/status-pages/{statusPage}`
- **Path parameters:** `statusPage`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, slug, description, theme } }`
- **Logical CLI:** `gq ploi status-pages show-status-page`
- **Source:** [Ploi API reference — Get status page](https://developers.ploi.io/status-pages/get-status-page)

### List status pages

- **Method/path:** `GET /api/status-pages`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, name, slug, description, theme }, links, meta }`
- **Logical CLI:** `gq ploi status-pages list-status-pages`
- **Source:** [Ploi API reference — List status pages](https://developers.ploi.io/status-pages/list-status-pages)

## system-users

### Create system user

- **Method/path:** `POST /api/servers/{server}/system-users`
- **Path parameters:** `server`
- **Request:** body — `name (string; required)`, `sudo (boolean; optional)`, `receive_password (boolean; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, root, created_at } }`; `{ data: { id, name, root, created_at }, password }`
- **Logical CLI:** `gq ploi system-users create-system-user`
- **Source:** [Ploi API reference — Create system user](https://developers.ploi.io/system-users/create-system-user)

### Delete system user

- **Method/path:** `DELETE /api/servers/{server}/system-users/{systemUser}`
- **Path parameters:** `server`, `systemUser`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `empty response body`; **notes:** documented empty response body
- **Logical CLI:** `gq ploi system-users delete-system-user`
- **Source:** [Ploi API reference — Delete system user](https://developers.ploi.io/system-users/delete-system-user)

### Get system user

- **Method/path:** `GET /api/servers/{server}/system-users/{systemUser}`
- **Path parameters:** `server`, `systemUser`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, name, root, created_at } }`
- **Logical CLI:** `gq ploi system-users show-system-user`
- **Source:** [Ploi API reference — Get system user](https://developers.ploi.io/system-users/get-system-user)

### List system users

- **Method/path:** `GET /api/servers/{server}/system-users`
- **Path parameters:** `server`
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, name, root, created_at }, links, meta }`
- **Logical CLI:** `gq ploi system-users list-system-users`
- **Source:** [Ploi API reference — List system users](https://developers.ploi.io/system-users/list-system-users)

## tenants

### Create tenant

- **Method/path:** `POST /api/servers/{server}/sites/{site}/tenants`
- **Path parameters:** `server`, `site`
- **Request:** body — `tenants (array; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { tenants, count, main } }`
- **Logical CLI:** `gq ploi tenants create-tenant`
- **Source:** [Ploi API reference — Create tenant](https://developers.ploi.io/tenants/create-tenant)

### Delete certificate

- **Method/path:** `POST /api/servers/{server}/sites/{site}/tenants/{tenant}/revoke-certificate`
- **Path parameters:** `server`, `site`, `tenant`
- **Request:** body — `webhook (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `HTTP response example (not JSON body)`; **notes:** 404 behavior documented; source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi tenants delete-certificate`
- **Source:** [Ploi API reference — Delete certificate](https://developers.ploi.io/tenants/delete-certificate)

### Delete tenant

- **Method/path:** `DELETE /api/servers/{server}/sites/{site}/tenants/{tenant}`
- **Path parameters:** `server`, `site`, `tenant`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `HTTP response example (not JSON body)`; **notes:** 404 behavior documented; source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi tenants delete-tenant`
- **Source:** [Ploi API reference — Delete tenant](https://developers.ploi.io/tenants/delete-tenant)

### Get NGINX configuration

- **Method/path:** `GET /api/servers/{server}/sites/{site}/tenants/{tenant}/nginx-configuration`
- **Path parameters:** `server`, `site`, `tenant`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ content }`; **notes:** on-demand execution/retrieval is documented; 404 behavior documented; source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi tenants show-nginx-configuration-tenant`
- **Source:** [Ploi API reference — Get NGINX configuration](https://developers.ploi.io/tenants/get-nginx-configuration-tenant)

### List tenants

- **Method/path:** `GET /api/servers/{server}/sites/{site}/tenants`
- **Path parameters:** `server`, `site`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { tenants, count, main } }`
- **Logical CLI:** `gq ploi tenants list-tenants`
- **Source:** [Ploi API reference — List tenants](https://developers.ploi.io/tenants/list-tenants)

### Request certificate

- **Method/path:** `POST /api/servers/{server}/sites/{site}/tenants/{tenant}/request-certificate`
- **Path parameters:** `server`, `site`, `tenant`
- **Request:** body — `webhook (string; optional)`, `domains (string; optional)`, `additional[type] (string; optional)`, `force (boolean; optional)`, `additional[use_dns_provider] (boolean; optional)`, `additional[provider] (string; optional)`, `additional[secret] (string; optional)`, `additional[use_from_profile] (boolean; optional)`, `additional[credential] (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `HTTP response example (not JSON body)`; **notes:** 404 behavior documented; source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi tenants request-certificate`
- **Source:** [Ploi API reference — Request certificate](https://developers.ploi.io/tenants/request-certificate)

### Update NGINX configuration

- **Method/path:** `PATCH /api/servers/{server}/sites/{site}/tenants/{tenant}/nginx-configuration`
- **Path parameters:** `server`, `site`, `tenant`
- **Request:** body — `content (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** on-demand execution/retrieval is documented; 404 behavior documented; source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi tenants update-nginx-configuration-tenant`
- **Source:** [Ploi API reference — Update NGINX configuration](https://developers.ploi.io/tenants/update-nginx-configuration-tenant)

## user

### Get backup configuration

- **Method/path:** `GET /api/user/backup-configurations/{backupConfiguration}`
- **Path parameters:** `backupConfiguration`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, label, type, humanType, created_at } }`
- **Logical CLI:** `gq ploi user show-backup-configuration`
- **Source:** [Ploi API reference — Get backup configuration](https://developers.ploi.io/user/get-backup-configuration)

### Get server provider

- **Method/path:** `GET /api/user/server-providers/{provider}`
- **Path parameters:** `provider`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, label, name, created_at, provider } }`
- **Logical CLI:** `gq ploi user show-server-provider`
- **Source:** [Ploi API reference — Get server provider](https://developers.ploi.io/user/get-server-provider)

### Information

- **Method/path:** `GET /api/user`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { avatar, name, email, billing_details, country, timezone, created_at, plan, plan_expires_at } }`
- **Logical CLI:** `gq ploi user show`
- **Source:** [Ploi API reference — Information](https://developers.ploi.io/user/information)

### List backup configurations

- **Method/path:** `GET /api/user/backup-configurations`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, label, type, humanType, created_at }, links, meta }`
- **Logical CLI:** `gq ploi user list-backup-configurations`
- **Source:** [Ploi API reference — List backup configurations](https://developers.ploi.io/user/list-backup-configurations)

### List server providers

- **Method/path:** `GET /api/user/server-providers`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, label, name, created_at, provider }, links, meta }`
- **Logical CLI:** `gq ploi user list-server-providers`
- **Source:** [Ploi API reference — List server providers](https://developers.ploi.io/user/list-server-providers)

### List source control providers

- **Method/path:** `GET /api/user/source-control`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, label, name, provider, created_at }, links, meta }`
- **Logical CLI:** `gq ploi user list-source-control-providers`
- **Source:** [Ploi API reference — List source control providers](https://developers.ploi.io/user/list-source-control-providers)

### Repositories for source control provider

- **Method/path:** `GET /api/user/source-control/{provider}/repositories`
- **Path parameters:** `provider`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { repositories } }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi user repositories-for-source-control-providers`
- **Source:** [Ploi API reference — Repositories for source control provider](https://developers.ploi.io/user/repositories-for-source-control-providers)

### Show source control provider

- **Method/path:** `GET /api/user/source-control/{provider}`
- **Path parameters:** `provider`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, label, name, provider, created_at } }`; **notes:** source example uses a concrete ID/domain; normalized here
- **Logical CLI:** `gq ploi user show-source-control-providers`
- **Source:** [Ploi API reference — Show source control provider](https://developers.ploi.io/user/show-source-control-providers)

## webserver-templates

### Get webserver template

- **Method/path:** `GET /api/webserver-templates/{id}`
- **Path parameters:** `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: { id, label, content, created_at } }`
- **Logical CLI:** `gq ploi webserver-templates show-webserver-template`
- **Source:** [Ploi API reference — Get webserver template](https://developers.ploi.io/webserver-templates/get-webserver-template)

### List webserver templates

- **Method/path:** `GET /api/webserver-templates`
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** yes — documented `data`, `links`, and `meta` envelope
- **Response:** `{ data: array of { id, label, content, created_at }, links, meta }`
- **Logical CLI:** `gq ploi webserver-templates list-webserver-templates`
- **Source:** [Ploi API reference — List webserver templates](https://developers.ploi.io/webserver-templates/list-webserver-templates)

## wordpress-management

### Activate plugin

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/plugins/activate`
- **Path parameters:** `server`, `id`
- **Request:** body — `plugin (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress activate-plugin`
- **Source:** [Ploi API reference — Activate plugin](https://developers.ploi.io/wordpress-management/activate-plugin)

### Activate theme

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/themes/activate`
- **Path parameters:** `server`, `id`
- **Request:** body — `theme (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress activate-theme`
- **Source:** [Ploi API reference — Activate theme](https://developers.ploi.io/wordpress-management/activate-theme)

### Complete install

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/complete-install`
- **Path parameters:** `server`, `id`
- **Request:** body — `site_title (string; required)`, `admin_username (string; required)`, `admin_email (string; required)`, `admin_password (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; `{ errors }`
- **Logical CLI:** `gq ploi wordpress complete-install`
- **Source:** [Ploi API reference — Complete install](https://developers.ploi.io/wordpress-management/complete-install)

### Deactivate plugin

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/plugins/deactivate`
- **Path parameters:** `server`, `id`
- **Request:** body — `plugin (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress deactivate-plugin`
- **Source:** [Ploi API reference — Deactivate plugin](https://developers.ploi.io/wordpress-management/deactivate-plugin)

### Delete plugin

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/wordpress/plugins/delete`
- **Path parameters:** `server`, `id`
- **Request:** body — `plugin (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress delete-plugin`
- **Source:** [Ploi API reference — Delete plugin](https://developers.ploi.io/wordpress-management/delete-plugin)

### Delete repository

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/wordpress/repositories/{repository}`
- **Path parameters:** `server`, `id`, `repository`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi wordpress delete-repository`
- **Source:** [Ploi API reference — Delete repository](https://developers.ploi.io/wordpress-management/delete-repository)

### Delete theme

- **Method/path:** `DELETE /api/servers/{server}/sites/{id}/wordpress/themes/delete`
- **Path parameters:** `server`, `id`
- **Request:** body — `theme (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress delete-theme`
- **Source:** [Ploi API reference — Delete theme](https://developers.ploi.io/wordpress-management/delete-theme)

### Deploy all repositories

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/repositories/deploy-all`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi wordpress deploy-all-repositories`
- **Source:** [Ploi API reference — Deploy all repositories](https://developers.ploi.io/wordpress-management/deploy-all-repositories)

### Deploy repository

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/repositories/{repository}/deploy`
- **Path parameters:** `server`, `id`, `repository`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi wordpress deploy-repository`
- **Source:** [Ploi API reference — Deploy repository](https://developers.ploi.io/wordpress-management/deploy-repository)

### Install plugin

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/plugins/install`
- **Path parameters:** `server`, `id`
- **Request:** body — `plugin (string; required)`, `activate (boolean; optional)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress install-plugin`
- **Source:** [Ploi API reference — Install plugin](https://developers.ploi.io/wordpress-management/install-plugin)

### Install repository

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/repositories`
- **Path parameters:** `server`, `id`
- **Request:** body — `provider (string; required)`, `name (string; required)`, `branch (string; required)`, `target_directory (string; required)`, `source_provider_id (integer; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded
- **Logical CLI:** `gq ploi wordpress install-repository`
- **Source:** [Ploi API reference — Install repository](https://developers.ploi.io/wordpress-management/install-repository)

### Install theme

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/themes/install`
- **Path parameters:** `server`, `id`
- **Request:** body — `theme (string; required)`, `activate (boolean; optional)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress install-theme`
- **Source:** [Ploi API reference — Install theme](https://developers.ploi.io/wordpress-management/install-theme)

### List plugins

- **Method/path:** `GET /api/servers/{server}/sites/{id}/wordpress/plugins`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { name, title, status, version, update_version, auto_update } }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress list-plugins`
- **Source:** [Ploi API reference — List plugins](https://developers.ploi.io/wordpress-management/list-plugins)

### List repositories

- **Method/path:** `GET /api/servers/{server}/sites/{id}/wordpress/repositories`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { id, user, name, branch, type, target_directory, deploy_script, status } }`
- **Logical CLI:** `gq ploi wordpress list-repositories`
- **Source:** [Ploi API reference — List repositories](https://developers.ploi.io/wordpress-management/list-repositories)

### List themes

- **Method/path:** `GET /api/servers/{server}/sites/{id}/wordpress/themes`
- **Path parameters:** `server`, `id`
- **Request:** body — —; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ data: array of { name, title, status, version, update_version, auto_update } }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress list-themes`
- **Source:** [Ploi API reference — List themes](https://developers.ploi.io/wordpress-management/list-themes)

### Run WP-CLI command

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/wp-cli/run`
- **Path parameters:** `server`, `id`
- **Request:** body — `command (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ output }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress run-wp-cli-command`
- **Source:** [Ploi API reference — Run WP-CLI command](https://developers.ploi.io/wordpress-management/run-wp-cli-command)

### Search & replace

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/search-replace`
- **Path parameters:** `server`, `id`
- **Request:** body — `search (string; required)`, `replace (string; required)`, `dry_run (boolean; optional)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ output }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress search-replace`
- **Source:** [Ploi API reference — Search & replace](https://developers.ploi.io/wordpress-management/search-replace)

### Toggle XML-RPC

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/toggle-xmlrpc`
- **Path parameters:** `server`, `id`
- **Request:** body — `block (boolean; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi wordpress toggle-xmlrpc`
- **Source:** [Ploi API reference — Toggle XML-RPC](https://developers.ploi.io/wordpress-management/toggle-xmlrpc)

### Update plugin

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/plugins/update`
- **Path parameters:** `server`, `id`
- **Request:** body — `plugin (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress update-plugin`
- **Source:** [Ploi API reference — Update plugin](https://developers.ploi.io/wordpress-management/update-plugin)

### Update deploy script

- **Method/path:** `PATCH /api/servers/{server}/sites/{id}/wordpress/repositories/{repository}/deploy-script`
- **Path parameters:** `server`, `id`, `repository`
- **Request:** body — `deploy_script (string; required)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi wordpress update-repository-deploy-script`
- **Source:** [Ploi API reference — Update deploy script](https://developers.ploi.io/wordpress-management/update-repository-deploy-script)

### Update repository

- **Method/path:** `PATCH /api/servers/{server}/sites/{id}/wordpress/repositories/{repository}`
- **Path parameters:** `server`, `id`, `repository`
- **Request:** body — `user (string; optional)`, `name (string; optional)`, `branch (string; optional)`; query — —
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`
- **Logical CLI:** `gq ploi wordpress update-repository`
- **Source:** [Ploi API reference — Update repository](https://developers.ploi.io/wordpress-management/update-repository)

### Update theme

- **Method/path:** `POST /api/servers/{server}/sites/{id}/wordpress/themes/update`
- **Path parameters:** `server`, `id`
- **Request:** body — `theme (string; required)`; query — `ondemand (boolean; query)`, `ondemand=true`
- **Pagination:** no documented pagination envelope
- **Response:** `{ status, message }`; **notes:** operation may be queued/backgrounded; on-demand execution/retrieval is documented
- **Logical CLI:** `gq ploi wordpress update-theme`
- **Source:** [Ploi API reference — Update theme](https://developers.ploi.io/wordpress-management/update-theme)

## getting-started

### Teapot

- **Method/path:** GET /api/teapot
- **Path parameters:** —
- **Request:** body — —; query — —
- **Pagination:** no documented pagination envelope
- **Response:** { message, images, links }; **notes:** documented response status is 418
- **Logical CLI:** `gq ploi teapot show`
- **Source:** [Ploi API reference — Teapot](https://developers.ploi.io/getting-started/teapot)

## Ambiguities, duplicates, and undocumented behavior

- **No deprecation markers found.** The official resource sitemap, Teapot page, and endpoint pages contain no explicit “deprecated” designation. Absence of a marker is not proof that an undocumented route is supported.
- **Literal examples vs parameterized paths.** Several pages show concrete values in cURL instead of placeholders (aliases, Docker containers, backup IDs, load-balancer domains, tenant domains, source-control provider IDs). The inventory records the logical parameter and flags those rows; callers should not copy the example literal.
- **Same path, different operation semantics.** Site update and robot-access are both `PATCH /api/servers/{server}/sites/{site-or-id}` and are distinguished by their body fields. WordPress plugin/theme operations also reuse action-shaped paths with fields and the `ondemand` query switch.
- **Optional Horizon path segment.** The Horizon page's route badge is `GET /api/servers/{server}/sites/laravel/horizon/{type}`, but its default cURL uses the same path without `/{type}`. The page calls `type` optional and defaults it to `stats`, so this inventory records both route forms rather than treating `type` as a request body field.
- **Navigation method badges disagree with endpoint pages.** The API-reference landing page labels Update server, Update site, Update NGINX configuration, and Update container as `PUT`, and Change PHP version as `PUT`; the dedicated endpoint pages and cURL samples document `PATCH`, `PATCH`, `PATCH`, `PATCH`, and `POST`, respectively. This inventory follows each dedicated endpoint page. Sources: [API-reference landing page](https://developers.ploi.io/), [Update server](https://developers.ploi.io/servers/update-server), [Update site](https://developers.ploi.io/sites/update-site), [Update NGINX configuration](https://developers.ploi.io/sites/update-nginx-configuration), [Update container](https://developers.ploi.io/containers/update-container), and [Change PHP version](https://developers.ploi.io/sites/change-php-version).
- **Log pair.** [Log site](https://developers.ploi.io/sites/log-site) lists paginated log entries at '/log'; [Get log site](https://developers.ploi.io/sites/get-log-site) fetches one full entry at '/log/{log}'. The two pages are related, not duplicate operations.
- **NGINX pair.** Site and tenant NGINX pages have the same operation names but different paths; both say retrieval/update may happen on-demand and the update response asks the caller to reload/restart NGINX.
- **Pagination inconsistencies.** Some list-named pages show only `data` (for example aliases, queues, schedules, network rules, tenants, and WordPress resources) while others show `links`/`meta`. Database-backup list documents filters `server`, `site`, and `per_page`, but its example pagination links use `database_page`; this is recorded as the source shows it and should be treated as ambiguous. The CLI's client additionally follows `meta.next_page_url`, although the official pagination guide documents `links.next` but not that fallback.
- **Response inconsistencies.** Delete pages variously document an empty body, a 'message', or a 'data' object; some pages show HTTP response headers rather than a JSON body. Consumers should follow each row's source rather than assume one envelope.
- **Scope metadata.** The scopes guide says each endpoint has its own token scope, and the MCP guide says REST-style matching read/create scopes apply, but most resource pages do not state a required scope. Treat the scope as **undocumented per endpoint** unless the cited page explicitly provides one; do not infer it from the HTTP verb.
- **MCP is curated, not a one-to-one REST catalogue.** Ploi documents the streamable HTTP MCP server at 'https://ploi.io/api/mcp'; OAuth requires 'mcp:use', while API-token access uses REST scopes. Its published tool list omits infrastructure delete operations and includes some capabilities whose REST reference page is not a direct one-to-one tool (for example 'list-deployments', 'get-deployment-log', and 'reset-database-user-password'). Source: [MCP documentation](https://developers.ploi.io/getting-started/mcp).

## MCP tool cross-reference

The first-party MCP page publishes these curated logical tools (not HTTP paths):

- **Servers:** 'list-servers', 'get-server', 'create-server', 'list-server-providers', 'list-server-logs', 'list-server-services', 'restart-server-service', 'reload-server-service', 'restart-server'.
- **Sites:** 'list-sites', 'get-site', 'create-site', 'list-site-logs', 'get-site-env', 'update-site-env', 'get-nginx-config', 'update-nginx-config', 'enable-fastcgi-cache', 'disable-fastcgi-cache', 'flush-fastcgi-cache'.
- **Tenants/aliases:** 'list-site-tenants', 'add-site-tenants', 'get-tenant-nginx-config', 'update-tenant-nginx-config', 'request-tenant-certificate', 'revoke-tenant-certificate', 'list-site-aliases', 'add-site-aliases'.
- **Deployments:** 'deploy-site', 'list-deployments', 'get-deployment-log', 'get-deploy-script', 'update-deploy-script', 'get-site-repository', 'install-site-repository', 'toggle-quick-deploy'.
- **Databases:** 'list-databases', 'get-database', 'create-database', 'duplicate-database', 'acknowledge-database', 'list-database-users', 'create-database-user', 'attach-database-user', 'reset-database-user-password'.
- **Cronjobs, certificates, daemons/queues, firewall, insights:** 'list-cronjobs', 'create-cronjob'; 'list-certificates', 'request-certificate'; 'list-daemons', 'restart-daemon', 'list-site-queues', 'restart-site-queue'; 'list-firewall-rules', 'create-firewall-rule'; 'list-server-insights', 'get-server-insight', 'fix-server-insight', 'ignore-server-insight', 'delete-server-insight'.

Source: [Ploi MCP documentation](https://developers.ploi.io/getting-started/mcp). The page also warns that 'get-site-env' returns raw '.env' contents, which may contain secrets.

## Coverage validation

- [x] Sitemap-derived endpoint page set downloaded and checked: 224 resource URLs plus the Teapot endpoint, excluding one non-endpoint type catalogue from operation coverage.
- [x] All 224 endpoint pages have at least one documented route; the custom-server page has two operation sections, yielding 225 operations and 226 route forms when the Horizon endpoint's optional `/{type}` form is counted.
- [x] Every operation below records method, path, path parameters, request fields, pagination status, response shape/notes, logical CLI name, and a precise endpoint-page citation.
- [x] No live Ploi mutation was attempted.
