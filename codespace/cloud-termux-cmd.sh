#!/data/data/com.termux/files/usr/bin/bash
# Control the Clip Studio render cloud from Termux:  cloud on  |  cloud off
case "${1:-}" in
  on)  proot-distro login alpine -- bash /root/cloud-on.sh ;;
  off) proot-distro login alpine -- bash /root/cloud-off.sh ;;
  status) proot-distro login alpine -- gh codespace list ;;
  usage) proot-distro login alpine -- bash /root/cloud-usage.sh ;;
  *)   echo "Usage: cloud on   |   cloud off   |   cloud status   |   cloud usage" ;;
esac
