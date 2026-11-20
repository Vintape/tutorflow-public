# TutorFlow

Рабочее пространство онлайн-репетитора. Ученики, расписание, совместные доски, отчёты и оплаты связаны с занятиями.

[Открыть демонстрацию](https://vintape.github.io/tutorflow-public/)

## Демонстрация и приложение

Демонстрация на GitHub Pages показывает сценарии TutorFlow на вымышленных данных. Полное приложение запускается с сервером Express. Оно включает Better Auth, PostgreSQL или PGlite, доски tldraw с SQLite и отдельное подключение Google Календаря через OAuth.

Код приложения, конфигурация, миграции и тесты находятся в этом репозитории. Для публикации подготовлен отдельный снимок исходников.

## Локальный запуск

Требуются Node.js и pnpm указанных в `package.json` версий.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Откройте [локальный TutorFlow](http://localhost:3000). Зарегистрируйте тестовый аккаунт. В режиме разработки в папке `.data` появятся локальная база и файлы досок. Для внешнего PostgreSQL используйте параметры из `.env.example`. Ключ ИИ необязателен. Настройка календаря описана в [отдельной инструкции](docs/GOOGLE_CALENDAR_SETUP.md).

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

[Восстановление локального хранилища](docs/WORKSPACE_BACKUP.md) · [Репетиция PostgreSQL и SQLite](docs/POSTGRES_CANVAS_RECOVERY.md)

Доска использует tldraw. Условия её использования в опубликованном серверном приложении следует оценивать по лицензии SDK.

## GitHub Pages

Файлы демонстрации находятся в `pages/`. Их можно открыть локально через `python3 -m http.server --directory pages 8080`. GitHub Pages публикует корень ветки `gh-pages`, в которую копируются файлы из `pages/`.
