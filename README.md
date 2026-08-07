# sshproxy-openwrt

Прозрачный SSH-прокси для OpenWrt/Linux: TCP-трафик к подсетям из списка
перенаправляется netfilter-правилами на локальный порт и уходит в туннель через
SSH-сервер (`direct-tcpip`). На SSH-сервере должно быть включено
`AllowTcpForwarding yes`.

## Как это работает

```
LAN-клиент/хост ──(dst: 8.8.8.0/24, 10.0.0.0/8)──▶ nftables/iptables REDIRECT
                                                        │
                                                        ▼
                                              локальный порт 1080 (прокси)
                                                        │  SSH direct-tcpip
                                                        ▼
                                              SSH-сервер ──▶ исходный адресат
```

1. Команда `setup` создаёт правила в nat-таблице: для каждого адресата из
   `subnets` TCP-соединения перенаправляются (REDIRECT) на `listen`-порт.
   Обрабатываются и транзитный (PREROUTING), и локальный (OUTPUT) трафик.
2. Прокси получает исходный адресат через `SO_ORIGINAL_DST`, открывает
   SSH-канал `direct-tcpip` к этому адресату и копирует данные в обе стороны.

## Сборка

```sh
go build -trimpath -ldflags="-s -w" -o sshproxy .
```

## Настройка SSH-сервера

В `/etc/ssh/sshd_config`:

```
AllowTcpForwarding yes
PermitRootLogin yes   # при необходимости
```

## Использование

```sh
# установить правила пересылки
./sshproxy config.json setup

# запустить прокси
./sshproxy config.json run

# удалить правила пересылки
./sshproxy config.json teardown
```

`setup`/`teardown` требуют root (CAP_NET_ADMIN).

## Конфигурация

Пример — `config.json.example`:

```json
{
  "ssh": {
    "server": "vpn.example.com:22",
    "user": "root",
    "password": "secret",
    "key_file": "/root/.ssh/id_rsa",
    "key_passphrase": "",
    "known_hosts": "/root/.ssh/known_hosts",
    "ignore_host_key": false
  },
  "listen": "0.0.0.0:1080",
  "subnets": ["8.8.8.0/24", "10.0.0.0/8"],
  "firewall": "nft"
}
```

Поля:

| Поле | Описание |
|---|---|
| `ssh.server` | Адрес SSH-сервера `host:port` |
| `ssh.user` | Пользователь SSH |
| `ssh.password` | Пароль (либо `key_file`) |
| `ssh.key_file` | Приватный ключ (PEM/OpenSSH) |
| `ssh.key_passphrase` | Парольная фраза ключа |
| `ssh.known_hosts` | Путь к known_hosts (по умолчанию `~/.ssh/known_hosts`) |
| `ssh.ignore_host_key` | Не проверять ключ хоста (не рекомендуется) |
| `listen` | Адрес:порт приёма перенаправленного трафика |
| `subnets` | Список подсетей, трафик к которым уходит в туннель |
| `firewall` | `nft` / `iptables` / пусто (автоопределение) |

## OpenWrt: init.d + пакет apk

В каталоге `files/` — procd-сервис и UCI-конфиг. Команда `daemon` сама
создаёт правила netfilter при старте и удаляет их при остановке
(перехват SIGTERM/SIGINT), поэтому сервис полностью самоуправляем:

```sh
/etc/init.d/sshproxy enable
/etc/init.d/sshproxy start      # правила созданы, прокси запущен
/etc/init.d/sshproxy stop       # прокси остановлен, правила удалены
```

`/etc/config/sshproxy` содержит только путь к JSON-конфигу, все настройки
живут в самом JSON-файле (`/etc/sshproxy/config.json` по умолчанию):

```
config sshproxy 'sshproxy'
	option enabled '1'
	option config '/etc/sshproxy/config.json'
```

`option enabled` — включить сервис (`1`/`0`), `option config` — путь к
JSON-конфигу (формат описан в разделе «Конфигурация» выше). При старте
сервис передаёт этот файл в `daemon`-режим.

Сборка пакета:

```sh
# OpenWrt >= 25.12 (apk) — нужен apk-tools >= 3
make riscv64-apk ARCH=riscv64_generic      # или arm64-apk / make apk ARCH=x86_64
# OpenWrt < 25.12 (ipk)
make riscv64-ipk                           # или arm64-ipk / make ipk ARCH=...

# установка на устройстве
apk add --allow-untrusted sshproxy-openwrt-0.1-r1_riscv64_generic.apk
/etc/init.d/sshproxy enable && /etc/init.d/sshproxy start
```

Пакет зависит от `nftables`; при желании подписать apk передайте
`APK_KEY=/path/to/key.rsa`.

## LuCI

Интерфейс LuCI входит в тот же пакет (меню **Services → SSHProxy**):

- **Service** — статус (автозапуск и демон), кнопки Enable/Disable/Start/Restart/Stop.
- **Settings** — редактирование `/etc/sshproxy/config.json` (SSH, listen, подсети, firewall) с сохранением и перезапуском сервиса.
- **Log Viewer** — журнал из syslog, отфильтрованный по `sshproxy`.

При установке без `luci-base` файлы безвредны и не мешают headless-использованию.

## Замечания

- Поддерживаются только IPv4-подсети.
- Трафик к самому SSH-серверу исключается из редиректа (иначе — петля).
- SSH-соединение пересоздаётся автоматически при разрыве.
- На OpenWrt правила ставятся в `nat`-цепочки; прокси работает как сервис
  через procd/init.d.
