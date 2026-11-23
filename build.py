import sys,os
here=os.path.dirname(os.path.abspath(__file__))
sim=open(os.path.join(here,'shared/sim.js')).read()
tpl=open(os.path.join(here,'client/bunker-9.tpl.html')).read()
out=tpl.replace('/*B9SIM*/',sim)
assert '</script>' not in sim
open(sys.argv[1],'w').write(out)
print('built',sys.argv[1],len(out))
