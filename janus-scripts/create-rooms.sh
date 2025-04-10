#!/usr/bin/bash

rooms=6

if [ -z $1 ]; then
	file="janus.plugin.videoroom.jcfg"
else
	file=$1
fi

if [ ! -f $file ]; then
	echo "No such file $file"
	exit 1
fi

for ((i=1; i<=$rooms; i++)); do
	room="room-100$i"
	if [ -z "$(grep $room $file)" ]; then
		echo "
			$room: {
				description = \"VNC $i Camera\"
				publishers = 1
				bitrate = 128000
				fir_freq = 10
				record = false
			}" | sed -re 's/^\t{3}//' >> $file
		echo "Added entry for $room to $file"
	else
		echo "Entry for $room already in $file"
	fi
done
