'use strict';
'require fs';
'require ui';
'require view';
'require view.sshproxy.tools as tools';

// Настройки SSHProxy хранятся в JSON-файле (путь берётся из /etc/config/sshproxy,
// option config). Эта страница читает/пишет этот файл напрямую.

return view.extend({
    configFile: null,

    load: function()
    {
        return Promise.all([
            L.resolveDefault(fs.read('/etc/config/sshproxy'), ''),
            L.resolveDefault(fs.read('/etc/sshproxy/config.json'), null),
        ]).then(([uci_data, json_data]) => {
            // Путь к конфигу из UCI (option config).
            let m = uci_data.match(/option\s+config\s+'([^']+)'/);
            if (m) {
                this.configFile = m[1];
            }

            let cfg = { };
            if (json_data != null && json_data.trim() != '') {
                try {
                    cfg = JSON.parse(json_data);
                } catch(e) {
                    ui.addNotification(null, E('p', _('Invalid JSON in %s: %s').format('/etc/sshproxy/config.json', e.message)));
                }
            }
            return cfg;
        }).catch(e => {
            ui.addNotification(null, E('p', _('Unable to read the configuration') + ': %s'.format(e.message)));
            return null;
        });
    },

    // --- helpers ---
    textField: function(id, val, placeholder)
    {
        return E('input', {
            'id'          : id,
            'class'       : 'cbi-input-text',
            'type'        : 'text',
            'value'       : (val != null) ? val : '',
            'placeholder' : placeholder || '',
            'spellcheck'  : 'false',
            'autocomplete': 'off',
        });
    },

    passwordField: function(id, val, placeholder)
    {
        return E('input', {
            'id'          : id,
            'class'       : 'cbi-input-text',
            'type'        : 'password',
            'value'       : (val != null) ? val : '',
            'placeholder' : placeholder || '',
            'spellcheck'  : 'false',
            'autocomplete': 'off',
        });
    },

    boolField: function(id, val)
    {
        let inp = E('input', {
            'id'          : id,
            'class'       : 'cbi-input-checkbox',
            'type'        : 'checkbox',
        });
        if (val) {
            inp.checked = true;
        }
        return inp;
    },

    cbiRow: function(title, field, desc)
    {
        let f = E('div', { 'class': 'cbi-value-field' }, field);
        let row = E('div', { 'class': 'cbi-value' }, [
            E('label', { 'class': 'cbi-value-title' }, title),
            f,
        ]);
        if (desc) {
            f.appendChild(E('div', { 'class': 'cbi-value-description' }, desc));
        }
        return row;
    },

    section: function(title, desc, children)
    {
        return E('div', { 'class': 'cbi-section fade-in' }, [
            E('h3', { 'class': 'cbi-section-title' }, title),
            (desc ? E('div', { 'class': 'cbi-section-descr' }, desc) : null),
            E('div', { 'class': 'cbi-section-node' }, children),
        ]);
    },

    // Список подсетей (динамический).
    renderSubnets: function(subnets)
    {
        let list = subnets || [ ];
        let container = E('div', { 'id': 'subnet_list' });

        let addRow = function(value) {
            let row = E('div', { 'class': 'cbi-value' });
            let field = E('div', { 'class': 'cbi-value-field' });
            let input = E('input', {
                'class': 'cbi-input-text subnet-input',
                'type': 'text',
                'value': value || '',
                'placeholder': '10.0.0.0/8',
                'spellcheck': 'false',
            });
            let rm = E('button', { 'class': 'btn cbi-button-reset' }, _('Remove'));
            rm.onclick = function(ev) {
                ev.preventDefault();
                row.remove();
            };
            field.appendChild(input);
            field.appendChild(E('span', {}, ' '));
            field.appendChild(rm);
            row.appendChild(E('div', { 'class': 'cbi-value-title' }, ' '));
            row.appendChild(field);
            container.appendChild(row);
        };

        for (let i = 0; i < list.length; i++) {
            addRow(list[i]);
        }
        if (list.length == 0) {
            addRow('');
        }

        let add_btn = E('button', { 'class': 'btn cbi-button-add' }, _('Add subnet'));
        add_btn.onclick = function(ev) {
            ev.preventDefault();
            addRow('');
        };

        let wrapper = E('div', { }, [ container, E('div', { 'class': 'cbi-value' }, [
            E('div', { 'class': 'cbi-value-title' }, ' '),
            E('div', { 'class': 'cbi-value-field' }, add_btn),
        ]) ]);
        return wrapper;
    },

    collectSubnets: function()
    {
        let vals = [ ];
        let inputs = document.querySelectorAll('#subnet_list input.subnet-input');
        for (let i = 0; i < inputs.length; i++) {
            let v = inputs[i].value.trim();
            if (v != '') {
                vals.push(v);
            }
        }
        return vals;
    },

    collect: function()
    {
        let cfg = {
            ssh: {
                server:          document.getElementById('ssh_server').value.trim(),
                user:            document.getElementById('ssh_user').value.trim(),
                password:        document.getElementById('ssh_password').value,
                key_file:        document.getElementById('ssh_key_file').value.trim(),
                key_passphrase:  document.getElementById('ssh_key_passphrase').value,
                known_hosts:     document.getElementById('ssh_known_hosts').value.trim(),
                ignore_host_key: document.getElementById('ssh_ignore_host_key').checked,
            },
            listen:  document.getElementById('listen').value.trim(),
            subnets: this.collectSubnets(),
            firewall: document.getElementById('firewall').value.trim(),
        };
        return cfg;
    },

    writeFile: function(restart)
    {
        if (!this.configFile) {
            ui.addNotification(null, E('p', _('Config file path not found in /etc/config/sshproxy')));
            return;
        }
        let cfg = this.collect();
        return fs.write(this.configFile, JSON.stringify(cfg, null, 4) + '\n')
            .then(() => {
                ui.addNotification(null, E('p', _('Saved to %s').format(this.configFile)));
                if (restart) {
                    return tools.serviceActionEx('restart');
                }
            })
            .catch(e => {
                ui.addNotification(null, E('p', _('Unable to save configuration') + ': %s'.format(e.message)));
            });
    },

    render: function(cfg)
    {
        if (cfg == null) {
            return;
        }
        if (!this.configFile) {
            this.configFile = '/etc/sshproxy/config.json';
        }

        let ssh  = cfg.ssh || { };
        let subnets = Array.isArray(cfg.subnets) ? cfg.subnets : [ ];

        let general = this.section(_('General'), _('Settings are stored in %s').format(this.configFile), [
            this.cbiRow(_('Listen address'), this.textField('listen', cfg.listen, '0.0.0.0:1080'),
                _('Host:port the proxy listens on for redirected traffic.')),
            this.cbiRow(_('Firewall backend'), this.textField('firewall', cfg.firewall, 'nft'),
                _('Rule generator: "nft" or "iptables" (empty = autodetect).')),
            this.cbiRow(_('Subnets'), this.renderSubnets(subnets),
                _('Traffic to these subnets is redirected into the SSH tunnel.')),
        ]);

        let ssh_sec = this.section(_('SSH'), _('Remote SSH server that opens connections to the original destinations.'),
            [
            this.cbiRow(_('Server'), this.textField('ssh_server', ssh.server, 'vpn.example.com:22'),
                _('SSH server host:port.')),
            this.cbiRow(_('User'), this.textField('ssh_user', ssh.user, 'root'), null),
            this.cbiRow(_('Password'), this.passwordField('ssh_password', ssh.password),
                _('SSH password (or use a key file below).')),
            this.cbiRow(_('Private key'), this.textField('ssh_key_file', ssh.key_file, '/etc/sshproxy/id_rsa'),
                _('Path to the private key.')),
            this.cbiRow(_('Key passphrase'), this.passwordField('ssh_key_passphrase', ssh.key_passphrase),
                _('Passphrase for an encrypted key.')),
            this.cbiRow(_('known_hosts'), this.textField('ssh_known_hosts', ssh.known_hosts),
                _('Path to known_hosts (default: ~/.ssh/known_hosts).')),
            this.cbiRow(_('Ignore host key'), this.boolField('ssh_ignore_host_key', ssh.ignore_host_key),
                _('Do not verify the SSH host key (not recommended).')),
        ]);

        let btn_save = E('button', { 'class': 'btn cbi-button-save important', 'click': () => this.writeFile(false) }, _('Save'));
        let btn_apply = E('button', { 'class': 'btn cbi-button-apply important', 'click': () => this.writeFile(true) }, _('Save & Restart'));

        let btns = E('div', { 'class': 'right' }, [ btn_save, ' ', btn_apply ]);

        return E([
            E('h2', { 'class': 'fade-in' }, 'SSHProxy - ' + _('Settings')),
            general,
            ssh_sec,
            E('div', { 'class': 'cbi-section fade-in' }, btns),
        ]);
    },

    handleSave     : null,
    handleSaveApply: null,
    handleReset    : null,
});
