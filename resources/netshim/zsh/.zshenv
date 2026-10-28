# Termflow's local tabs start zsh with ZDOTDIR here. Each of these files runs your own
# file of the same name from where zsh normally reads it (TERMFLOW_USER_ZDOTDIR), in the
# usual order and without changing it. Afterwards the network tools in
# TERMFLOW_NETSHIM_BIN go first in PATH (see ../libexec/launchd-run) and ZDOTDIR is put back.

TERMFLOW_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$TERMFLOW_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
# Your .zshenv may set ZDOTDIR: the rest of your files are read from there.
TERMFLOW_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$TERMFLOW_ZDOTDIR
