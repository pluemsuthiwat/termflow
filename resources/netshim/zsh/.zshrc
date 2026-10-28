# /etc/zshrc put history under ${ZDOTDIR:-$HOME}, i.e. inside the app: keep it in yours.
[[ $HISTFILE == $ZDOTDIR/.zsh_history ]] && HISTFILE=$TERMFLOW_USER_ZDOTDIR/.zsh_history

TERMFLOW_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$TERMFLOW_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
TERMFLOW_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$TERMFLOW_ZDOTDIR

path=($TERMFLOW_NETSHIM_BIN ${path:#$TERMFLOW_NETSHIM_BIN})
